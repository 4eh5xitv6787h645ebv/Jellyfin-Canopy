using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Jellyseerr
{
    /// <summary>
    /// DI singleton implementation of <see cref="IJellyseerrClient"/>. Method
    /// bodies moved verbatim from <c>JellyfinEnhancedControllerBase</c> with two
    /// mechanical adaptations: controller result helpers became direct result
    /// objects (<see cref="ContentResult"/>/<see cref="ObjectResult"/>/…), and
    /// the ambient <c>User</c>/<c>IsAdminUser()</c> context became the explicit
    /// <see cref="JellyseerrCaller"/> parameter.
    ///
    /// This also absorbs the former <c>JellyseerrUserResolver</c> (the
    /// auto-request services' duplicate user-id lookup): one resolver, one cache.
    /// Its cache-key normalisation (dashless, lowercase) now applies to the
    /// shared <see cref="ISeerrCache"/> user caches so every caller format
    /// (dashed/N/upper) hits the same entry.
    /// </summary>
    public sealed class JellyseerrClient : IJellyseerrClient
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<JellyseerrClient> _logger;
        private readonly IUserManager _userManager;
        private readonly ISeerrCache _seerrCache;
        private readonly IPluginConfigProvider _configProvider;
        private readonly ISeerrParentalFilter _parentalFilter;

        public JellyseerrClient(
            IHttpClientFactory httpClientFactory,
            ILogger<JellyseerrClient> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            ISeerrParentalFilter parentalFilter)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _userManager = userManager;
            _seerrCache = seerrCache;
            _configProvider = configProvider;
            _parentalFilter = parentalFilter;
        }

        // ── URL / id helpers (hoisted from JellyseerrUserResolver) ───────────

        /// <summary>Splits the configured Jellyseerr URL list (newline/comma separated) into trimmed base URLs.</summary>
        public static string[] GetConfiguredUrls(string? urls)
        {
            return (urls ?? string.Empty)
                .Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(url => url.Trim().TrimEnd('/'))
                .Where(url => !string.IsNullOrWhiteSpace(url))
                .ToArray();
        }

        /// <summary>Normalizes a Jellyfin user id for comparison and cache keys (dashes removed, lowercase).</summary>
        public static string NormalizeUserId(string userId)
        {
            return userId.Replace("-", string.Empty).ToLowerInvariant();
        }

        // ── Status probe ─────────────────────────────────────────────────────

        public async Task<bool> GetStatusActiveAsync()
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrEmpty(config.JellyseerrApiKey) || string.IsNullOrEmpty(config.JellyseerrUrls))
            {
                return false;
            }

            var urls = GetConfiguredUrls(config.JellyseerrUrls);
            var httpClient = SeerrHttpHelper.CreateClient(_httpClientFactory);
            httpClient.Timeout = TimeSpan.FromSeconds(15);

            foreach (var url in urls)
            {
                var requestUri = $"{url}/api/v1/status";
                try
                {
                    using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, requestUri, config.JellyseerrApiKey);
                    using var response = await httpClient.SendAsync(request);
                    var (_, error) = await SeerrHttpHelper.ReadResponseAsync(response, requestUri);
                    if (error == null)
                    {
                        return true;
                    }

                    _logger.LogWarning($"Seerr status check failed at {url}: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                }
                catch
                {
                    // Ignore and try next URL
                }
            }

            _logger.LogWarning("Could not establish a connection with any configured Seerr URL. Status is inactive.");
            return false;
        }

        // Cached wrapper so a Seerr outage doesn't fan out N status probes from
        // the negative-user-cache window.
        private async Task<bool> IsSeerrReachableCached()
        {
            lock (_seerrCache.SeerrStatusCacheLock)
            {
                if (_seerrCache.SeerrStatusCache.HasValue
                    && DateTime.UtcNow - _seerrCache.SeerrStatusCache.Value.CachedAt < _seerrCache.SeerrStatusCacheTtl)
                {
                    return _seerrCache.SeerrStatusCache.Value.Active;
                }
            }

            bool active = await GetStatusActiveAsync();
            lock (_seerrCache.SeerrStatusCacheLock)
            {
                _seerrCache.SeerrStatusCache = (active, DateTime.UtcNow);
            }

            return active;
        }

        // ── User resolution ──────────────────────────────────────────────────

        public bool IsImportBlocked(string jellyfinUserId, PluginConfiguration config)
        {
            var blockedIds = Helpers.Jellyseerr.JellyseerrUserImportHelper.GetBlockedUserIds(config.JellyseerrImportBlockedUsers);
            if (blockedIds.Count == 0)
            {
                return false;
            }

            var normalizedId = jellyfinUserId.Replace("-", "");
            return blockedIds.Contains(normalizedId);
        }

        public async Task<JellyseerrUser?> GetJellyseerrUser(string jellyfinUserId, bool bypassCache = false, bool allowAutoImport = true)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                _logger.LogWarning("Seerr configuration is missing. Cannot look up user ID.");
                return null;
            }

            // Skip blocked users entirely — no lookup, no import, no API calls
            if (IsImportBlocked(jellyfinUserId, config))
            {
                return null;
            }

            var cacheKey = NormalizeUserId(jellyfinUserId);
            bool cacheEnabled = !config.JellyseerrDisableCache && !bypassCache;
            if (cacheEnabled)
            {
                lock (_seerrCache.UserCacheLock)
                {
                    if (_seerrCache.UserCache.TryGetValue(cacheKey, out var cached))
                    {
                        // Negative entries use a much shorter TTL so transient
                        // failures don't poison discovery for 30 min after recovery.
                        var ttl = cached.User == null ? TimeSpan.FromSeconds(60) : _seerrCache.GetUserIdCacheTtl();
                        if (DateTime.UtcNow - cached.CachedAt < ttl)
                        {
                            return cached.User;
                        }
                    }
                }
            }

            var urls = GetConfiguredUrls(config.JellyseerrUrls);
            var httpClient = SeerrHttpHelper.CreateClient(_httpClientFactory);
            httpClient.Timeout = TimeSpan.FromSeconds(15);

            foreach (var url in urls)
            {
                var requestUri = $"{url}/api/v1/user?take=1000"; // Fetch all users to find a match
                try
                {
                    using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, requestUri, config.JellyseerrApiKey);
                    using var response = await httpClient.SendAsync(request);
                    var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, requestUri);

                    if (error != null)
                    {
                        // Distinct error logging by class lets admins triage
                        // (HTML response = reverse proxy, 401 = key wrong, etc.)
                        _logger.LogWarning($"Failed to fetch users from Seerr at {url}: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                        continue;
                    }

                    var usersResponse = JsonSerializer.Deserialize<JsonElement>(json!);
                    if (usersResponse.TryGetProperty("results", out var usersArray))
                    {
                        var users = JsonSerializer.Deserialize<List<JellyseerrUser>>(usersArray.ToString());
                        var normalizedJellyfinUserId = jellyfinUserId.Replace("-", "");
                        var user = users?.FirstOrDefault(u => string.Equals(u.JellyfinUserId, normalizedJellyfinUserId, StringComparison.OrdinalIgnoreCase));
                        if (user != null)
                        {
                            if (cacheEnabled)
                            {
                                lock (_seerrCache.UserCacheLock)
                                {
                                    _seerrCache.UserCache[cacheKey] = (user, DateTime.UtcNow);
                                }
                            }

                            return user;
                        }

                        _logger.LogInformation($"No matching Jellyfin User ID found in the {users?.Count ?? 0} users from {url}");
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError($"Exception while trying to get Seerr user ID from {url}: {ex.Message}");
                }
            }

            // User not found — attempt just-in-time import into Jellyseerr.
            // `allowAutoImport=false` is passed by read-only callers (e.g. the
            // Permission Audit endpoint, which advertises itself as a non-
            // mutating check). Without this guard, clicking "Run Audit" with
            // auto-import enabled would silently create Seerr users as a side
            // effect — including users an admin may have deliberately kept out
            // of Seerr (but not yet added to the blocklist).
            var importDefinite = false;
            if (allowAutoImport && config.JellyseerrAutoImportUsers)
            {
                _logger.LogInformation($"User not found in Jellyseerr. Attempting just-in-time import for Jellyfin User ID {ResolveUserDisplay(jellyfinUserId)}...");
                var (importedUser, definite) = await TryAutoImportJellyseerrUser(jellyfinUserId, urls, httpClient);
                importDefinite = definite;
                if (importedUser != null)
                {
                    if (cacheEnabled)
                    {
                        lock (_seerrCache.UserCacheLock)
                        {
                            _seerrCache.UserCache[cacheKey] = (importedUser, DateTime.UtcNow);
                        }
                    }

                    return importedUser;
                }
            }

            // Only negative-cache when the import gave a definite "not importable" answer.
            // Transient failures (network errors, exceptions) should not be cached so the
            // next request can retry immediately.
            if (cacheEnabled && importDefinite)
            {
                lock (_seerrCache.UserCacheLock)
                {
                    _seerrCache.UserCache[cacheKey] = (null, DateTime.UtcNow);
                }
            }

            _logger.LogWarning($"Could not find or import a matching Seerr user for Jellyfin User ID {ResolveUserDisplay(jellyfinUserId)} after checking all URLs.");
            return null;
        }

        private async Task<(JellyseerrUser? User, bool Definite)> TryAutoImportJellyseerrUser(string jellyfinUserId, string[] urls, HttpClient httpClient)
        {
            var config = _configProvider.ConfigurationOrNull;
            var apiKey = config?.JellyseerrApiKey ?? string.Empty;

            // Jellyseerr requires dashless UUIDs — dashed format causes empty email and UNIQUE constraint errors
            var normalizedUserId = jellyfinUserId.Replace("-", "");

            // Track whether we got any HTTP response from Jellyseerr (vs network failures).
            // This determines whether a null result should be negative-cached or retried.
            var reachedJellyseerr = false;

            foreach (var url in urls)
            {
                try
                {
                    var importUri = $"{url}/api/v1/user/import-from-jellyfin";
                    var requestBody = JsonSerializer.Serialize(new { jellyfinUserIds = new[] { normalizedUserId } });

                    using var importRequest = SeerrHttpHelper.BuildRequest(HttpMethod.Post, importUri, apiKey, bodyJson: requestBody);
                    using var importResponse = await httpClient.SendAsync(importRequest);
                    reachedJellyseerr = true;
                    var (importJson, importError) = await SeerrHttpHelper.ReadResponseAsync(importResponse, importUri);

                    if (importError != null)
                    {
                        // Email collision is a definite failure — a renamed/deleted Jellyfin user left
                        // an orphaned Jellyseerr account with the same email. Won't resolve on retry.
                        if (!string.IsNullOrEmpty(importError.Message)
                            && importError.Message.Contains("UNIQUE constraint failed: user.email", StringComparison.OrdinalIgnoreCase))
                        {
                            _logger.LogWarning($"Could not auto-import Jellyfin User ID {ResolveUserDisplay(jellyfinUserId)}: an existing Jellyseerr account has a conflicting email (possibly from a previous user that was renamed or deleted). Remove the conflicting user in Jellyseerr to resolve this.");
                            return (null, true);
                        }

                        _logger.LogWarning($"Failed to auto-import user to Jellyseerr at {url}: code={importError.Code} status={importError.HttpStatus} cf-ray={importError.CfRay} — {importError.Message}");
                        continue;
                    }

                    // The import endpoint returns an array of newly created users.
                    // Parse it directly to avoid a second API call.
                    var importedUsers = JsonSerializer.Deserialize<List<JellyseerrUser>>(importJson!);
                    var user = importedUsers?.FirstOrDefault(u => string.Equals(u.JellyfinUserId, normalizedUserId, StringComparison.OrdinalIgnoreCase));
                    if (user != null)
                    {
                        _logger.LogInformation($"Auto-imported Seerr user ID {user.Id} for Jellyfin User {ResolveUserDisplay(jellyfinUserId)}");
                        return (user, true);
                    }

                    // Some Jellyseerr versions return an empty array even on success (user already existed
                    // but wasn't in the import response). Fall back to a full user list query to find them.
                    _logger.LogInformation($"Import succeeded at {url} but user not in response. Doing fresh lookup...");
                    var lookupUri = $"{url}/api/v1/user?take=1000";
                    using var lookupRequest = SeerrHttpHelper.BuildRequest(HttpMethod.Get, lookupUri, apiKey);
                    using var lookupResponse = await httpClient.SendAsync(lookupRequest);
                    var (lookupJson, lookupError) = await SeerrHttpHelper.ReadResponseAsync(lookupResponse, lookupUri);
                    if (lookupError == null && lookupJson != null)
                    {
                        var lookupRoot = JsonSerializer.Deserialize<JsonElement>(lookupJson);
                        if (lookupRoot.TryGetProperty("results", out var usersArray))
                        {
                            var allUsers = JsonSerializer.Deserialize<List<JellyseerrUser>>(usersArray.ToString());
                            var found = allUsers?.FirstOrDefault(u => string.Equals(u.JellyfinUserId, normalizedUserId, StringComparison.OrdinalIgnoreCase));
                            if (found != null)
                            {
                                _logger.LogInformation($"Found Seerr user ID {found.Id} for Jellyfin User {ResolveUserDisplay(jellyfinUserId)} via fresh lookup");
                                return (found, true);
                            }
                        }
                    }
                    else if (lookupError != null)
                    {
                        _logger.LogDebug($"Fresh lookup at {url} failed: code={lookupError.Code} status={lookupError.HttpStatus} cf-ray={lookupError.CfRay}");
                    }

                    // Import succeeded and fresh lookup found nothing — user is genuinely not importable
                    return (null, true);
                }
                catch (HttpRequestException ex)
                {
                    // Network errors, timeouts, etc. are transient — try the next URL
                    _logger.LogDebug($"Connection error during auto-import for Jellyfin User {ResolveUserDisplay(jellyfinUserId)} at {url}: {ex.Message}");
                }
                catch (JsonException ex)
                {
                    // Invalid Jellyseerr response — log warning but try next URL
                    _logger.LogWarning($"Invalid response from Jellyseerr during auto-import for Jellyfin User {ResolveUserDisplay(jellyfinUserId)} at {url}: {ex.Message}");
                }
            }

            // Definite only if we actually got an HTTP response from at least one URL.
            // If all URLs failed with exceptions (network down), this is transient and should not be cached.
            return (null, reachedJellyseerr);
        }

        public async Task<string?> GetJellyseerrUserId(string jellyfinUserId, bool allowAutoImport = true)
        {
            var config = _configProvider.ConfigurationOrNull;
            bool cacheEnabled = config == null || !config.JellyseerrDisableCache;
            var cacheKey = NormalizeUserId(jellyfinUserId);

            // Check cache first (unless disabled)
            if (cacheEnabled)
            {
                lock (_seerrCache.UserIdCacheLock)
                {
                    if (_seerrCache.UserIdCache.TryGetValue(cacheKey, out var cached) &&
                        DateTime.UtcNow - cached.CachedAt < _seerrCache.GetUserIdCacheTtl())
                    {
                        return cached.JellyseerrUserId;
                    }
                }
            }

            var user = await GetJellyseerrUser(jellyfinUserId, allowAutoImport: allowAutoImport);
            var jellyseerrUserId = user?.Id.ToString();

            if (!string.IsNullOrEmpty(jellyseerrUserId) && cacheEnabled)
            {
                lock (_seerrCache.UserIdCacheLock)
                {
                    _seerrCache.UserIdCache[cacheKey] = (jellyseerrUserId, DateTime.UtcNow);
                }
            }

            return jellyseerrUserId;
        }

        // ── Proxy core ───────────────────────────────────────────────────────

        private static bool IsCacheableApiPath(string apiPath, HttpMethod method)
        {
            if (method != HttpMethod.Get) return false;

            // /discover/watchlist is mutable per-user state. Caching
            // it for 10 min would mean: user adds movie → next watchlist GET
            // still returns the old payload until TTL expires. /api/v1/issue
            // is also mutable (status changes on assignment / resolution).
            // tightened to /api/v1/issue prefix to avoid
            // accidentally matching future endpoints with "issue" in the name.
            if (apiPath.Contains("/discover/watchlist", StringComparison.OrdinalIgnoreCase)) return false;
            if (apiPath.StartsWith("/api/v1/issue", StringComparison.OrdinalIgnoreCase)) return false;

            // include /search/keyword (typeahead spam) and item-detail
            // endpoints (movie/tv/season — fetched repeatedly by more-info-modal).
            return apiPath.Contains("/discover/") ||
                   apiPath.Contains("/genre") ||
                   apiPath.Contains("/similar") ||
                   apiPath.Contains("/recommendations") ||
                   apiPath.Contains("/person/") ||
                   apiPath.Contains("/collection/") ||
                   apiPath.Contains("/keyword") ||
                   apiPath.Contains("/search") ||
                   apiPath.StartsWith("/api/v1/movie/", StringComparison.OrdinalIgnoreCase) ||
                   apiPath.StartsWith("/api/v1/tv/", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsPublicScopeApiPath(string apiPath)
        {
            // Genre slider, network/studio/keyword discovery — pure TMDB
            // metadata, identical across users.
            if (apiPath.Contains("/discover/genreslider/", StringComparison.OrdinalIgnoreCase)) return true;
            // Query-string-form discovery (the shape JE actually emits).
            // Discovery responses include media.requests/requestedBy etc.
            // BUT the proxy uses X-Api-User header to filter requestedBy
            // server-side, so the body is per-user — except for very simple
            // shapes (no requestedBy filter, no language). Keep these
            // per-user to be safe; only the truly content-only TMDB sliders
            // and direct genre/keyword/person lookups are shared.
            if (apiPath.StartsWith("/api/v1/genres/", StringComparison.OrdinalIgnoreCase)) return true;
            if (apiPath.StartsWith("/api/v1/person/", StringComparison.OrdinalIgnoreCase)) return true;
            if (apiPath.StartsWith("/api/v1/keyword", StringComparison.OrdinalIgnoreCase)) return true;
            // For discover/movies?genre=X and discover/tv?genre=X paths
            // (query-string discovery), the response includes mediaInfo
            // for items the user has watched. Keep per-user.
            // Per-user response includes mediaInfo.requestedBy filtered to
            // the calling user's perspective and 4K availability based on
            // user permission, so KEEP per-user for movie/{id}, tv/{id},
            // collection/{id}, similar/recommendations, search, and
            // /discover/* with any filter.
            return false;
        }

        private void EvictMovieTvCacheForRequest(string body)
        {
            if (string.IsNullOrEmpty(body)) return;
            try
            {
                using var doc = JsonDocument.Parse(body);
                if (!doc.RootElement.TryGetProperty("mediaId", out var mediaIdEl)) return;
                if (!doc.RootElement.TryGetProperty("mediaType", out var mediaTypeEl)) return;
                var mediaId = mediaIdEl.GetInt32();
                var mediaType = mediaTypeEl.GetString();
                if (mediaType != "movie" && mediaType != "tv") return;
                // The cache key shape is `{userId}:{apiPath}`. We want to match
                // EITHER the bare detail (apiPath ends with `/api/v1/movie/12`)
                // OR a sub-path (apiPath starts with `/api/v1/movie/12/` —
                // for `/similar`, `/recommendations`, `/season/1`, etc).
                var bareSuffix = $":/api/v1/{mediaType}/{mediaId}";
                var subPathInfix = $":/api/v1/{mediaType}/{mediaId}/";
                lock (_seerrCache.ResponseCacheLock)
                {
                    var keys = _seerrCache.ResponseCache.Keys
                        .Where(k =>
                            k.EndsWith(bareSuffix, StringComparison.Ordinal)
                            || k.Contains(subPathInfix, StringComparison.Ordinal))
                        .ToList();
                    foreach (var k in keys) _seerrCache.ResponseCache.Remove(k);
                }
            }
            catch { /* best-effort eviction */ }
        }

        public async Task<IActionResult> ProxyRequestAsync(string apiPath, HttpMethod method, string? content, JellyseerrCaller caller)
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                _logger.LogWarning("Seerr integration is not configured or enabled.");
                return new ObjectResult("Seerr integration is not configured or enabled.") { StatusCode = 503 };
            }

            // The caller identity is resolved by the controller from the
            // authenticated principal (never caller-controlled headers).
            var jellyfinUserId = caller.JellyfinUserId;
            if (string.IsNullOrEmpty(jellyfinUserId))
            {
                _logger.LogWarning("Could not resolve Jellyfin user ID from the authenticated principal.");
                return new ForbidResult();
            }

            // resolve the Seerr user ONCE up-front and reuse for
            // both ID-extraction and the non-admin permission check below.
            // Previously made TWO calls (and TWO Seerr round-trips when
            // JellyseerrDisableCache=true), doubling load on debugging admins.
            var seerrUser = await GetJellyseerrUser(jellyfinUserId);
            var jellyseerrUserId = seerrUser?.Id.ToString();
            if (string.IsNullOrEmpty(jellyseerrUserId))
            {
                _logger.LogWarning($"Could not find a Jellyseerr user for Jellyfin user {ResolveUserDisplay(jellyfinUserId)}. Aborting request.");
                // When the lookup returns null because every Seerr URL
                // is returning a Cloudflare/proxy HTML challenge, the generic
                // "user not linked" message misleads the admin. Do one quick
                // reachability probe so the frontend gets a structured reason
                // it can render in a banner, matching /jellyseerr/user-status.
                // The probe is cached so a Seerr outage doesn't fan out N
                // status probes from the negative-user-cache window.
                bool reachable = await IsSeerrReachableCached();

                if (!reachable)
                {
                    // Admins get a pointer to the JE log (which carries the
                    // full code=Cloudflare5xx status=. cf-ray=. line);
                    // non-admins get plain copy.
                    var unreachableMsg = caller.IsAdmin
                        ? "Can't reach Seerr. Check the JE log for cf-ray / Content-Type / status details."
                        : "Can't reach Seerr right now. Please try again in a moment.";
                    return new ObjectResult(new
                    {
                        error = true,
                        code = "unreachable",
                        message = unreachableMsg
                    })
                    { StatusCode = 502 };
                }

                if (IsImportBlocked(jellyfinUserId, config))
                {
                    return new ObjectResult(new
                    {
                        error = true,
                        code = "blocked",
                        message = "Your administrator has disabled Seerr for your account."
                    })
                    { StatusCode = 403 };
                }

                return new NotFoundObjectResult(new
                {
                    error = true,
                    code = "unlinked",
                    message = "Current Jellyfin user is not linked to a Jellyseerr user."
                });
            }

            // Enforce Seerr permissions for write operations and sensitive reads.
            // Jellyfin admins bypass all permission checks (they can do anything in Seerr).
            // For non-admins, validate before proxying so we return a clear 403 rather than
            // letting Seerr reject the request with a generic error.
            if (!caller.IsAdmin)
            {
                // reuse the Seerr user we already resolved above — no second
                // GetJellyseerrUser call.
                if (seerrUser != null)
                {
                    var perms = seerrUser.Permissions;
                    bool isSeerrAdmin = JellyseerrPermissionHelper.HasPermission(perms, JellyseerrPermission.ADMIN);

                    if (!isSeerrAdmin)
                    {
                        // POST /api/v1/request — make a request
                        if (method == HttpMethod.Post && apiPath.StartsWith("/api/v1/request", StringComparison.OrdinalIgnoreCase))
                        {
                            if (!JellyseerrPermissionHelper.HasAnyPermission(perms,
                                JellyseerrPermission.REQUEST | JellyseerrPermission.REQUEST_MOVIE | JellyseerrPermission.REQUEST_TV))
                                return new ObjectResult(new { code = "no_request_permission", message = "You do not have permission to make requests in Seerr." }) { StatusCode = 403 };
                        }

                        // POST /api/v1/issue — report an issue
                        if (method == HttpMethod.Post && apiPath.StartsWith("/api/v1/issue", StringComparison.OrdinalIgnoreCase))
                        {
                            if (!JellyseerrPermissionHelper.HasAnyPermission(perms,
                                JellyseerrPermission.CREATE_ISSUES | JellyseerrPermission.MANAGE_ISSUES))
                                return new ObjectResult(new { code = "no_issue_permission", message = "You do not have permission to report issues in Seerr." }) { StatusCode = 403 };
                        }

                        // GET /api/v1/issue — view issues list (any of: ?query, exact, /id)
                        // The /api/v1/issue/{id} path was previously not gated by this
                        // check.— non-admin without VIEW_ISSUES could
                        // fetch any issue by id by guessing.
                        if (method == HttpMethod.Get && (apiPath.StartsWith("/api/v1/issue?", StringComparison.OrdinalIgnoreCase)
                            || apiPath.StartsWith("/api/v1/issue/", StringComparison.OrdinalIgnoreCase)
                            || string.Equals(apiPath, "/api/v1/issue", StringComparison.OrdinalIgnoreCase)))
                        {
                            if (!JellyseerrPermissionHelper.HasAnyPermission(perms,
                                JellyseerrPermission.VIEW_ISSUES | JellyseerrPermission.MANAGE_ISSUES))
                                return new ObjectResult(new { code = "no_issue_view_permission", message = "You do not have permission to view issues in Seerr." }) { StatusCode = 403 };
                        }

                        // GET /api/v1/service/sonarr|radarr, /api/v1/service/{type}/{id},
                        // /api/v1/overrideRule — these expose admin-context Seerr data
                        // (instance lists, quality profiles, root folders, override rules)
                        // used by the "advanced request" modal. Require REQUEST_ADVANCED
                        // to match Seerr's own permission model for this feature
                        //.
                        if (method == HttpMethod.Get && (
                            apiPath.StartsWith("/api/v1/service/", StringComparison.OrdinalIgnoreCase)
                            || apiPath.StartsWith("/api/v1/overrideRule", StringComparison.OrdinalIgnoreCase)))
                        {
                            if (!JellyseerrPermissionHelper.HasAnyPermission(perms,
                                JellyseerrPermission.REQUEST_ADVANCED | JellyseerrPermission.MANAGE_REQUESTS))
                                return new ObjectResult(new { code = "no_advanced_permission", message = "You do not have permission to use advanced request options." }) { StatusCode = 403 };
                        }
                    }
                }
            }

            // Check server-side response cache for cacheable endpoints.
            // bifurcate cache key. Public discovery
            // endpoints return identical content for all users, so include the
            // user-id in the key only for endpoints whose response actually
            // varies per-user (mediaInfo.requests, watchlist, partial-requests
            // setting, requested-by-me filters, etc).
            bool isCacheable = IsCacheableApiPath(apiPath, method) && !config.JellyseerrDisableCache;
            bool isPublicScope = IsPublicScopeApiPath(apiPath);
            var cacheKey = isPublicScope
                ? $"public:{apiPath}"
                : $"{jellyfinUserId}:{apiPath}";
            if (isCacheable)
            {
                string? cachedContent = null;
                lock (_seerrCache.ResponseCacheLock)
                {
                    if (_seerrCache.ResponseCache.TryGetValue(cacheKey, out var cached) &&
                        DateTime.UtcNow - cached.CachedAt < _seerrCache.GetResponseCacheTtl())
                    {
                        cachedContent = cached.Content;
                    }
                }

                if (cachedContent != null)
                {
                    // Filter per-caller on the way out; the cached body itself stays
                    // user-neutral (never store a per-user-filtered view under a
                    // possibly-shared public: cache key).
                    var filteredCached = await _parentalFilter.FilterListBodyAsync(cachedContent, apiPath, caller);
                    return new ContentResult { Content = filteredCached, ContentType = "application/json" };
                }
            }

            var urls = GetConfiguredUrls(config.JellyseerrUrls);
            var httpClient = SeerrHttpHelper.CreateClient(_httpClientFactory);
            httpClient.Timeout = TimeSpan.FromSeconds(15);

            int lastStatusCode = 502;
            object lastErrorBody = new { error = true, code = "unreachable", message = "Can't reach Seerr right now. Please try again in a moment." };

            foreach (var url in urls)
            {
                var requestUri = $"{url}{apiPath}";
                // High-frequency endpoints that don't need a per-call INFO line.
                // also covers /search/keyword (typeahead) and item-
                // detail endpoints (movie/tv/season) which more-info-modal hits
                // repeatedly.
                bool isQuietEndpoint = apiPath.Contains("/similar")
                    || apiPath.Contains("/recommendations")
                    || apiPath.Contains("/discover/")
                    || apiPath.Contains("/search")
                    || apiPath.Contains("/genre")
                    || apiPath.Contains("/keyword")
                    || apiPath.StartsWith("/api/v1/movie/", StringComparison.OrdinalIgnoreCase)
                    || apiPath.StartsWith("/api/v1/tv/", StringComparison.OrdinalIgnoreCase)
                    || apiPath.StartsWith("/api/v1/person/", StringComparison.OrdinalIgnoreCase);
                bool isIssuePolling = apiPath.Contains("/issue?");

                if (!isQuietEndpoint)
                {
                    var userDisplay = ResolveUserDisplay(jellyfinUserId);
                    if (isIssuePolling)
                        LogPollingRequest(userDisplay, requestUri, $"{jellyfinUserId}:{apiPath}");
                    else
                        _logger.LogInformation($"Proxying Seerr request for user {userDisplay} to: {requestUri}");
                }

                try
                {
                    using var request = SeerrHttpHelper.BuildRequest(method, requestUri, config.JellyseerrApiKey, jellyseerrUserId, content);
                    if (content != null) _logger.LogDebug($"Request body: {content}");

                    using var response = await httpClient.SendAsync(request);
                    var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, requestUri);

                    if (error == null && json != null)
                    {
                        // Cache only verified-JSON 2xx responses. The Content-Type
                        // guard inside ReadResponseAsync prevents HTML challenge
                        // pages from being cached as JSON for 10 min.
                        if (isCacheable)
                        {
                            lock (_seerrCache.ResponseCacheLock)
                            {
                                _seerrCache.ResponseCache[cacheKey] = (json, DateTime.UtcNow);

                                if (_seerrCache.ResponseCache.Count > 200 || _seerrCache.ResponseCache.Count % 50 == 0)
                                {
                                    var staleKeys = _seerrCache.ResponseCache
                                        .Where(kv => DateTime.UtcNow - kv.Value.CachedAt > _seerrCache.GetResponseCacheTtl())
                                        .Select(kv => kv.Key)
                                        .ToList();
                                    foreach (var key in staleKeys)
                                        _seerrCache.ResponseCache.Remove(key);
                                }
                            }
                        }

                        // a successful POST /api/v1/request changes
                        // mediaInfo.requests on the corresponding /movie/{id}
                        // or /tv/{id} response. Evict cached detail entries
                        // for that media so the next modal open shows fresh
                        // state ("Pending" instead of "Request").
                        if (method == HttpMethod.Post
                            && apiPath.StartsWith("/api/v1/request", StringComparison.OrdinalIgnoreCase)
                            && content != null)
                        {
                            EvictMovieTvCacheForRequest(content);
                        }

                        // Cache above stores the raw, user-neutral body; the parental
                        // filter runs per-caller on the way out.
                        var filteredJson = await _parentalFilter.FilterListBodyAsync(json, apiPath, caller);
                        return new ContentResult { Content = filteredJson, ContentType = "application/json" };
                    }

                    _logger.LogWarning($"Seerr request failed for user {ResolveUserDisplay(jellyfinUserId)} at {url}: code={error!.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");

                    // Map structured error → HTTP status + structured envelope.
                    // The frontend can switch on `code` to display a meaningful
                    // banner instead of "discovery silently disappeared".
                    lastStatusCode = error.Code switch
                    {
                        SeerrErrorCode.HtmlResponse => 502,
                        SeerrErrorCode.UpstreamRedirect => 502,
                        SeerrErrorCode.Cloudflare5xx => 502,
                        SeerrErrorCode.Unauthorized => 401,
                        SeerrErrorCode.Forbidden => 403,
                        _ => error.HttpStatus > 0 ? error.HttpStatus : 502,
                    };
                    // admins keep the upstream URL in the response;
                    // non-admins get a sanitised version that strips it.
                    lastErrorBody = caller.IsAdmin ? error.ToAdminResponseShape() : error.ToResponseShape();
                }
                catch (Exception ex)
                {
                    _logger.LogError($"Failed to connect to Seerr URL for user {ResolveUserDisplay(jellyfinUserId)}: {url}. Error: {ex.Message}");
                    if (caller.IsAdmin)
                    {
                        lastErrorBody = new { error = true, code = "unreachable", message = $"Failed to reach {url}: {ex.Message}" };
                    }
                    else
                    {
                        lastErrorBody = new { error = true, code = "unreachable", message = "Can't reach Seerr right now. Please try again in a moment." };
                    }
                }
            }

            return new ObjectResult(lastErrorBody) { StatusCode = lastStatusCode };
        }

        // ── Watchlist / requests helpers ─────────────────────────────────────

        public async Task<List<WatchlistItem>?> GetWatchlistForUser(string jellyseerrUserId)
        {
            try
            {
                var config = _configProvider.ConfigurationOrNull;
                if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
                {
                    return null;
                }

                var urls = GetConfiguredUrls(config.JellyseerrUrls);
                var httpClient = SeerrHttpHelper.CreateClient(_httpClientFactory);

                foreach (var url in urls)
                {
                    try
                    {
                        var requestUri = $"{url}/api/v1/user/{jellyseerrUserId}/watchlist";
                        using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, requestUri, config.JellyseerrApiKey);
                        using var response = await httpClient.SendAsync(request);
                        var (content, error) = await SeerrHttpHelper.ReadResponseAsync(response, requestUri);

                        if (error == null && content != null)
                        {
                            var json = JsonDocument.Parse(content);

                            if (json.RootElement.TryGetProperty("results", out var results))
                            {
                                var items = new List<WatchlistItem>();
                                foreach (var item in results.EnumerateArray())
                                {
                                    if (item.TryGetProperty("tmdbId", out var tmdbId) &&
                                        item.TryGetProperty("mediaType", out var mediaType))
                                    {
                                        items.Add(new WatchlistItem
                                        {
                                            TmdbId = tmdbId.GetInt32(),
                                            MediaType = mediaType.GetString() ?? "movie"
                                        });
                                    }
                                }

                                return items;
                            }
                        }
                        else if (error != null)
                        {
                            _logger.LogWarning($"Failed to get watchlist from {url}: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning($"Failed to get watchlist from {url}: {ex.Message}");
                        continue;
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogError($"Error getting Seerr watchlist: {ex}");
            }

            return null;
        }

        public async Task<List<WatchlistItem>?> GetRequestsForUser(string jellyseerrUserId)
        {
            try
            {
                var config = _configProvider.ConfigurationOrNull;
                if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
                {
                    return null;
                }

                var urls = GetConfiguredUrls(config.JellyseerrUrls);
                var httpClient = SeerrHttpHelper.CreateClient(_httpClientFactory);

                foreach (var url in urls)
                {
                    try
                    {
                        var requestUri = $"{url}/api/v1/request?take=500&skip=0&sort=added";
                        using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, requestUri, config.JellyseerrApiKey, jellyseerrUserId);
                        using var response = await httpClient.SendAsync(request);
                        var (content, error) = await SeerrHttpHelper.ReadResponseAsync(response, requestUri);
                        if (error != null)
                        {
                            _logger.LogWarning($"Failed to get requests from {url}: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                            continue;
                        }

                        var json = JsonDocument.Parse(content!);

                        if (!json.RootElement.TryGetProperty("results", out var results))
                        {
                            continue;
                        }

                        var items = new List<WatchlistItem>();

                        foreach (var item in results.EnumerateArray())
                        {
                            if (!BelongsToUser(item, jellyseerrUserId))
                            {
                                continue;
                            }

                            var parsed = ParseRequestItem(item);
                            if (parsed != null)
                            {
                                items.Add(parsed);
                            }
                        }

                        return items;
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning($"Failed to get requests from {url}: {ex.Message}");
                        continue;
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogError($"Error getting Seerr requests: {ex}");
            }

            return null;
        }

        private static bool BelongsToUser(JsonElement requestElement, string jellyseerrUserId)
        {
            if (requestElement.TryGetProperty("requestedBy", out var requestedBy))
            {
                if (requestedBy.ValueKind == JsonValueKind.Number && requestedBy.TryGetInt32(out var idNumber))
                {
                    return string.Equals(idNumber.ToString(), jellyseerrUserId, StringComparison.OrdinalIgnoreCase);
                }

                if (requestedBy.ValueKind == JsonValueKind.String)
                {
                    var idStr = requestedBy.GetString();
                    if (!string.IsNullOrEmpty(idStr) && string.Equals(idStr, jellyseerrUserId, StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }

                if (requestedBy.ValueKind == JsonValueKind.Object && requestedBy.TryGetProperty("id", out var idProp))
                {
                    if ((idProp.ValueKind == JsonValueKind.Number && idProp.TryGetInt32(out var objId) && string.Equals(objId.ToString(), jellyseerrUserId, StringComparison.OrdinalIgnoreCase)) ||
                        (idProp.ValueKind == JsonValueKind.String && string.Equals(idProp.GetString() ?? string.Empty, jellyseerrUserId, StringComparison.OrdinalIgnoreCase)))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        private static WatchlistItem? ParseRequestItem(JsonElement requestElement)
        {
            int tmdbId = 0;
            string mediaType = "";

            if (requestElement.TryGetProperty("media", out var media))
            {
                if (media.TryGetProperty("tmdbId", out var tmdbProp))
                {
                    tmdbId = tmdbProp.GetInt32();
                }

                if (media.TryGetProperty("mediaType", out var mtProp) && mtProp.ValueKind == JsonValueKind.String)
                {
                    mediaType = mtProp.GetString() ?? "";
                }
            }

            if (tmdbId == 0 && requestElement.TryGetProperty("tmdbId", out var topTmdb))
            {
                tmdbId = topTmdb.GetInt32();
            }

            if (string.IsNullOrWhiteSpace(mediaType) && requestElement.TryGetProperty("mediaType", out var topMediaType) && topMediaType.ValueKind == JsonValueKind.String)
            {
                mediaType = topMediaType.GetString() ?? "";
            }

            if (tmdbId == 0 || string.IsNullOrWhiteSpace(mediaType))
            {
                return null;
            }

            return new WatchlistItem
            {
                TmdbId = tmdbId,
                MediaType = mediaType
            };
        }

        // ── Logging helpers ──────────────────────────────────────────────────

        private string ResolveUserDisplay(string userId)
        {
            try
            {
                // Accept both dashed and dashless GUIDs
                if (Guid.TryParse(userId, out var guid) ||
                    Guid.TryParseExact(userId, "N", out guid))
                {
                    var user = _userManager.GetUserById(guid);
                    if (user != null)
                        return $"{user.Username} ({userId})";
                }
            }
            catch { /* non-fatal */ }
            return userId;
        }

        // Dedup tracker for high-frequency polling log lines.
        // Key = (userId, apiPath), Value = (last logged message, count since last log, last log time)
        private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, (string LastMsg, int Count, DateTime LastLogged)>
            _pollLogDedup = new();
        private static readonly TimeSpan _pollLogInterval = TimeSpan.FromMinutes(5);

        private void LogPollingRequest(string userDisplay, string requestUri, string dedupKey)
        {
            var now = DateTime.UtcNow;
            _pollLogDedup.AddOrUpdate(
                dedupKey,
                _ =>
                {
                    // First occurrence — log immediately
                    _logger.LogInformation($"Proxying Seerr request for user {userDisplay} to: {requestUri}");
                    return (requestUri, 0, now);
                },
                (_, existing) =>
                {
                    var newCount = existing.Count + 1;
                    if (now - existing.LastLogged >= _pollLogInterval)
                    {
                        // Enough time has passed — emit a consolidated summary
                        _logger.LogInformation($"Proxying Seerr request for user {userDisplay} to: {requestUri} (repeated {newCount}x in last {_pollLogInterval.TotalMinutes:0}m)");
                        return (requestUri, 0, now);
                    }
                    // Still within the quiet window — suppress
                    return (existing.LastMsg, newCount, existing.LastLogged);
                });
        }
    }
}
