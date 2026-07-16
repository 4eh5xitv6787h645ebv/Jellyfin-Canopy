using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Seerr
{
    /// <summary>
    /// DI singleton implementation of <see cref="ISeerrClient"/>. Method
    /// bodies moved verbatim from <c>JellyfinCanopyControllerBase</c> with two
    /// mechanical adaptations: controller result helpers became direct result
    /// objects (<see cref="ContentResult"/>/<see cref="ObjectResult"/>/…), and
    /// the ambient <c>User</c>/<c>IsAdminUser()</c> context became the explicit
    /// <see cref="SeerrCaller"/> parameter.
    ///
    /// This also absorbs the former <c>SeerrUserResolver</c> (the
    /// auto-request services' duplicate user-id lookup): one resolver, one cache.
    /// Its cache-key normalisation (dashless, lowercase) now applies to the
    /// shared <see cref="ISeerrCache"/> user caches so every caller format
    /// (dashed/N/upper) hits the same entry.
    /// </summary>
    public sealed class SeerrClient : ISeerrClient
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<SeerrClient> _logger;
        private readonly IUserManager _userManager;
        private readonly ISeerrCache _seerrCache;
        private readonly IPluginConfigProvider _configProvider;
        private readonly ISeerrParentalFilter _parentalFilter;
        private readonly ConcurrentDictionary<string, SemaphoreSlim> _userResolutionGates = new(
            StringComparer.OrdinalIgnoreCase);

        public SeerrClient(
            IHttpClientFactory httpClientFactory,
            ILogger<SeerrClient> logger,
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

        // ── URL / id helpers (hoisted from SeerrUserResolver) ───────────

        /// <summary>Splits the configured Seerr URL list (newline/comma separated) into trimmed base URLs.</summary>
        public static string[] GetConfiguredUrls(string? urls)
            => SeerrUrlIdentity.ParseConfigured(urls);

        /// <summary>Normalizes a Jellyfin user id for comparison and cache keys (dashes removed, lowercase).</summary>
        public static string NormalizeUserId(string userId)
        {
            return userId.Replace("-", string.Empty).ToLowerInvariant();
        }

        /// <summary>
        /// One-way identity for every serialized plugin setting. Cache entries
        /// carry this in addition to the provider revision because custom/test
        /// providers can mutate the same configuration object in place. The
        /// digest binds credentials without storing or logging them.
        /// </summary>
        internal static string BuildConfigurationIdentity(PluginConfiguration configuration)
        {
            ArgumentNullException.ThrowIfNull(configuration);
            return Convert.ToHexString(
                SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(configuration)));
        }

        private static string? FindConfiguredSource(
            IEnumerable<string> configuredUrls,
            string? candidateSourceUrl)
        {
            var normalizedCandidate = SeerrUrlIdentity.Normalize(candidateSourceUrl);
            if (string.IsNullOrWhiteSpace(normalizedCandidate)) return null;

            // SourceUrl is an identity-domain token, not just a host name. URL
            // paths (and potentially queries) are case-sensitive, so an
            // ignore-case comparison can validate /TenantA against /tenanta and
            // replay an instance-local user id to a different backend. Exact
            // matching may cause a harmless fresh lookup after cosmetic config
            // edits, but it never weakens affinity.
            return configuredUrls.FirstOrDefault(configuredUrl => string.Equals(
                configuredUrl,
                normalizedCandidate,
                StringComparison.Ordinal));
        }

        // ── Status probe ─────────────────────────────────────────────────────

        public async Task<bool> GetStatusActiveAsync()
        {
            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            if (!integration.IsActive)
            {
                return false;
            }

            var urls = integration.Urls;
            var apiKey = integration.ApiKey;
            SeerrDispatchFence dispatchFence = integration.CreateDispatchFence(_configProvider);
            var httpClient = SeerrHttpHelper.CreateClient(_httpClientFactory);
            httpClient.Timeout = TimeSpan.FromSeconds(15);

            foreach (var url in urls)
            {
                // A failed probe may await long enough for an administrator to
                // disable or replace the integration. Revalidate before every
                // failover dispatch so retained snapshot credentials are never
                // used for the next configured URL.
                if (!integration.IsCurrent(_configProvider))
                {
                    return false;
                }

                var requestUri = $"{url}/api/v1/status";
                try
                {
                    using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, requestUri, apiKey);
                    var (_, error, _) = await SeerrHttpHelper.SendAndReadJsonAsync(
                        httpClient,
                        request,
                        requestUri,
                        dispatchFence).ConfigureAwait(false);
                    if (error == null)
                    {
                        return integration.IsCurrent(_configProvider);
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

        // ── 4K capability ────────────────────────────────────────────────────

        public async Task<Seerr4kCapability> GetSeerr4kCapabilityAsync(string jellyfinUserId, bool isAdmin = false)
        {
            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            if (!integration.IsActive)
            {
                return new Seerr4kCapability(false, false, false, false);
            }

            var config = integration.Configuration!;
            var configurationRevision = integration.ConfigurationRevision;
            var configStamp = SeerrMutationConfigStamp.Capture(config, configurationRevision);
            var configuredUrls = integration.Urls;
            var apiKey = integration.ApiKey;
            var cacheDisabled = config.SeerrDisableCache;
            var masterMovie4k = config.SeerrEnable4KRequests;
            var masterTv4k = config.SeerrEnable4KTvRequests;
            bool IsConfigurationCurrent() => integration.IsCurrent(_configProvider)
                && configStamp.Matches(
                    _configProvider.ConfigurationOrNull,
                    _configProvider.ConfigurationRevision);
            if (!IsConfigurationCurrent())
            {
                return new Seerr4kCapability(false, false, false, false);
            }

            // Resolve the identity domain first. Public settings are neutral
            // between users of one Seerr instance, not between independently
            // configured instances.
            var resolution = await ResolveSeerrUser(
                jellyfinUserId,
                bypassCache: true,
                allowAutoImport: false).ConfigureAwait(false);
            if (!IsConfigurationCurrent())
            {
                return new Seerr4kCapability(false, false, false, false);
            }

            var sourceUrl = configuredUrls.FirstOrDefault(url => string.Equals(
                url,
                SeerrUrlIdentity.Normalize(resolution.User?.SourceUrl),
                StringComparison.Ordinal));
            if (!resolution.IsFound || string.IsNullOrWhiteSpace(sourceUrl))
            {
                _logger.LogWarning(
                    "4K capability user resolution returned {Status}; capability will not be published as available. {Reason}",
                    resolution.Status,
                    resolution.FailureReason);
                return new Seerr4kCapability(false, false, false, false);
            }

            var (movie4k, series4k) = await GetPublic4kSettingsAsync(
                sourceUrl,
                configuredUrls,
                apiKey,
                cacheDisabled,
                configurationRevision,
                configStamp).ConfigureAwait(false);
            if (!IsConfigurationCurrent())
            {
                return new Seerr4kCapability(false, false, false, false);
            }

            if (isAdmin)
            {
                // A Jellyfin admin bypasses the Seerr per-user 4K permission gate in
                // the proxy (caller.IsAdmin), so projecting only the linked Seerr
                // user's bits would show canRequest4k*=false while the server would
                // actually accept the request. Mirror the gate: their capability is
                // server-4K-enabled, still AND'd with the JC admin master switch
                // (which applies to admins too — consistent with the gate order).
                return new Seerr4kCapability(
                    movie4k,
                    series4k,
                    movie4k && masterMovie4k,
                    series4k && masterTv4k);
            }

            var perms = resolution.User!.Permissions;
            bool canMovie = movie4k && SeerrPermissionHelper.CanRequest4k(perms, isTv: false);
            bool canTv = series4k && SeerrPermissionHelper.CanRequest4k(perms, isTv: true);
            return new Seerr4kCapability(movie4k, series4k, canMovie, canTv);
        }

        /// <summary>
        /// Fetches Seerr's user-neutral <c>/api/v1/settings/public</c> 4K flags,
        /// cached. Sends NO per-user header so the cached value is safe to share
        /// across users. Returns (false, false) when Seerr is unconfigured or
        /// every configured URL fails.
        /// </summary>
        private async Task<(bool Movie4k, bool Series4k)> GetPublic4kSettingsAsync(
            string sourceUrl,
            IReadOnlyList<string> capturedConfiguredUrls,
            string capturedApiKey,
            bool cacheDisabled,
            long configurationRevision,
            SeerrMutationConfigStamp configStamp)
        {
            bool IsConfigurationCurrent() => configStamp.Matches(
                _configProvider.ConfigurationOrNull,
                _configProvider.ConfigurationRevision);
            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            var configuredSource = capturedConfiguredUrls
                .FirstOrDefault(url => string.Equals(url, sourceUrl, StringComparison.Ordinal));
            var apiKey = capturedApiKey;
            if (configuredSource == null
                || string.IsNullOrEmpty(apiKey)
                || !IsConfigurationCurrent())
            {
                return (false, false);
            }

            var apiKeyFingerprint = Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(apiKey)));

            if (!cacheDisabled)
            {
                (bool Movie4k, bool Series4k)? cachedResult = null;
                lock (_seerrCache.Public4kSettingsCacheLock)
                {
                    if (_seerrCache.Public4kSettingsCache.TryGetValue(configuredSource, out var cached)
                        && cached.ConfigurationRevision == configurationRevision
                        && string.Equals(cached.ApiKeyFingerprint, apiKeyFingerprint, StringComparison.Ordinal)
                        && DateTime.UtcNow - cached.CachedAt < _seerrCache.Public4kSettingsCacheTtl)
                    {
                        cachedResult = (cached.Movie4kEnabled, cached.Series4kEnabled);
                    }
                }

                if (cachedResult.HasValue)
                {
                    return IsConfigurationCurrent()
                        ? cachedResult.Value
                        : (false, false);
                }
            }

            var httpClient = SeerrHttpHelper.CreateClient(_httpClientFactory);
            httpClient.Timeout = TimeSpan.FromSeconds(15);
            var requestUri = $"{configuredSource}/api/v1/settings/public";
            try
            {
                if (!IsConfigurationCurrent())
                {
                    return (false, false);
                }

                // User-neutral within this pinned source: no X-Api-User.
                using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, requestUri, apiKey);
                var (json, error, _) = await SeerrHttpHelper.SendAndReadJsonAsync(
                    httpClient,
                    request,
                    requestUri,
                    integration
                        .CreateDispatchFence(_configProvider)
                        .Restrict(IsConfigurationCurrent)).ConfigureAwait(false);
                if (!IsConfigurationCurrent())
                {
                    return (false, false);
                }

                if (error != null || string.IsNullOrEmpty(json))
                {
                    if (error != null)
                    {
                        _logger.LogWarning($"Failed to fetch Seerr public settings at {configuredSource}: code={error.Code} status={error.HttpStatus} — {error.Message}");
                    }

                    return (false, false);
                }

                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (!root.TryGetProperty("movie4kEnabled", out var movieSetting)
                    || movieSetting.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
                    || !root.TryGetProperty("series4kEnabled", out var seriesSetting)
                    || seriesSetting.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                {
                    _logger.LogWarning("Malformed Seerr public-settings response at {Url}", configuredSource);
                    return (false, false);
                }

                var movie4k = movieSetting.ValueKind == JsonValueKind.True;
                var series4k = seriesSetting.ValueKind == JsonValueKind.True;
                if (!cacheDisabled && IsConfigurationCurrent())
                {
                    var publishedEntry = (
                        Movie4kEnabled: movie4k,
                        Series4kEnabled: series4k,
                        CachedAt: DateTime.UtcNow,
                        ConfigurationRevision: configurationRevision,
                        ApiKeyFingerprint: apiKeyFingerprint);
                    lock (_seerrCache.Public4kSettingsCacheLock)
                    {
                        _seerrCache.Public4kSettingsCache[configuredSource] = publishedEntry;
                    }

                    if (!IsConfigurationCurrent())
                    {
                        lock (_seerrCache.Public4kSettingsCacheLock)
                        {
                            if (_seerrCache.Public4kSettingsCache.TryGetValue(configuredSource, out var published)
                                && published.Equals(publishedEntry))
                            {
                                _seerrCache.Public4kSettingsCache.Remove(configuredSource);
                            }
                        }
                    }
                }

                return IsConfigurationCurrent()
                    ? (movie4k, series4k)
                    : (false, false);
            }
            catch (JsonException ex)
            {
                _logger.LogWarning(ex, "Malformed Seerr public-settings response at {Url}", configuredSource);
            }
            catch (HttpRequestException ex)
            {
                _logger.LogWarning(ex, "Transport error fetching Seerr public settings at {Url}", configuredSource);
            }
            catch (TaskCanceledException)
            {
                // Pinned source timed out; never fall over to another identity domain.
            }

            return (false, false);
        }

        // ── User resolution ──────────────────────────────────────────────────

        public bool IsImportBlocked(string jellyfinUserId, PluginConfiguration config)
        {
            var blockedIds = Helpers.Seerr.SeerrUserImportHelper.GetBlockedUserIds(config.SeerrImportBlockedUsers);
            if (blockedIds.Count == 0)
            {
                return false;
            }

            var normalizedId = jellyfinUserId.Replace("-", "");
            return blockedIds.Contains(normalizedId);
        }

        public async Task<SeerrUser?> GetSeerrUser(
            string jellyfinUserId,
            bool bypassCache = false,
            bool allowAutoImport = true)
            => (await ResolveSeerrUser(jellyfinUserId, bypassCache, allowAutoImport).ConfigureAwait(false)).User;

        public async Task<SeerrUserResolution> ResolveSeerrUser(
            string jellyfinUserId,
            bool bypassCache = false,
            bool allowAutoImport = true,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var resolutionGate = _userResolutionGates.GetOrAdd(
                NormalizeUserId(jellyfinUserId),
                static _ => new SemaphoreSlim(1, 1));
            await resolutionGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                // Serialize a user's complete lookup/import transaction. The
                // short retry timestamp prevents sequential storms; this gate
                // also closes the race where a slower concurrent absence read
                // could reach POST after the winning importer cleared its
                // reservation on success.
                return await ResolveSeerrUserCore(
                    jellyfinUserId,
                    bypassCache,
                    allowAutoImport,
                    cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                resolutionGate.Release();
            }
        }

        private async Task<SeerrUserResolution> ResolveSeerrUserCore(
            string jellyfinUserId,
            bool bypassCache,
            bool allowAutoImport,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            if (!integration.IsActive)
            {
                _logger.LogWarning("Seerr integration is disabled or unavailable. Cannot look up user ID.");
                return new SeerrUserResolution(
                    SeerrUserResolutionStatus.Unavailable,
                    FailureReason: integration.State == SeerrIntegrationState.Disabled
                        ? "Seerr integration is disabled."
                        : "Seerr integration is not configured.");
            }

            var config = integration.Configuration!;
            var configurationRevision = integration.ConfigurationRevision;
            var configurationIdentity = BuildConfigurationIdentity(config);
            var autoImportThrottleKey = BuildAutoImportThrottleKey(
                NormalizeUserId(jellyfinUserId),
                integration.GenerationIdentity);
            var importConfigStamp = SeerrMutationConfigStamp.Capture(
                config,
                configurationRevision);
            bool ConfigurationIsCurrent() => integration.IsCurrent(_configProvider)
                && importConfigStamp.Matches(
                    _configProvider.ConfigurationOrNull,
                    _configProvider.ConfigurationRevision);
            SeerrDispatchFence dispatchFence = integration
                .CreateDispatchFence(_configProvider)
                .Restrict(ConfigurationIsCurrent);
            static SeerrUserResolution ConfigurationChanged() =>
                SeerrUserResolution.Incomplete(
                    "Seerr configuration changed during user lookup; retry the request.");
            void RemovePublishedUserCache(string publishedCacheKey, SeerrUser? expectedUser)
            {
                lock (_seerrCache.UserCacheLock)
                {
                    if (_seerrCache.UserCache.TryGetValue(publishedCacheKey, out var published)
                        && published.ConfigurationRevision == configurationRevision
                        && string.Equals(
                            published.ConfigurationIdentity,
                            configurationIdentity,
                            StringComparison.Ordinal)
                        && ReferenceEquals(published.User, expectedUser))
                    {
                        _seerrCache.UserCache.Remove(publishedCacheKey);
                    }
                }
            }

            // Reading the object and its monotonic revision are separate
            // provider calls. A replacement between them deliberately creates
            // a stamp that cannot match either generation.
            if (!ConfigurationIsCurrent())
            {
                return ConfigurationChanged();
            }

            // Skip blocked users entirely — no lookup, no import, no API calls
            if (IsImportBlocked(jellyfinUserId, config))
            {
                return new SeerrUserResolution(SeerrUserResolutionStatus.Blocked);
            }

            var urls = integration.Urls;

            var cacheKey = NormalizeUserId(jellyfinUserId);
            bool cacheEnabled = !config.SeerrDisableCache && !bypassCache;
            SeerrUserResolution? cachedResolution = null;
            var invalidatedPositiveCache = false;
            if (cacheEnabled)
            {
                lock (_seerrCache.UserCacheLock)
                {
                    if (_seerrCache.UserCache.TryGetValue(cacheKey, out var cached))
                    {
                        if (cached.ConfigurationRevision != configurationRevision
                            || !string.Equals(
                                cached.ConfigurationIdentity,
                                configurationIdentity,
                                StringComparison.Ordinal))
                        {
                            _seerrCache.UserCache.Remove(cacheKey);
                            invalidatedPositiveCache = cached.User != null;
                        }
                        else
                        {
                            // Negative entries use a much shorter TTL so transient
                            // failures don't poison discovery for 30 min after recovery.
                            var ttl = cached.User == null ? TimeSpan.FromSeconds(60) : _seerrCache.GetUserIdCacheTtl();
                            if (DateTime.UtcNow - cached.CachedAt < ttl)
                            {
                                if (cached.User == null)
                                {
                                    cachedResolution = SeerrUserResolution.NotFound("Cached authoritative absence.");
                                }
                                else
                                {
                                    // Numeric Seerr ids and permission masks are
                                    // instance-local. Never trust a positive cache
                                    // entry after its source URL is removed from the
                                    // current configuration: doing so can send the
                                    // new API key, caller identity, or a mutation to
                                    // the retired endpoint.
                                    var configuredSource = cached.User.Id > 0
                                        ? FindConfiguredSource(urls, cached.User.SourceUrl)
                                        : null;
                                    if (configuredSource != null)
                                    {
                                        cached.User.SourceUrl = configuredSource;
                                        cachedResolution = SeerrUserResolution.Found(cached.User);
                                    }
                                    else
                                    {
                                        _seerrCache.UserCache.Remove(cacheKey);
                                        invalidatedPositiveCache = true;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if (invalidatedPositiveCache)
            {
                // The legacy id-only cache carries no source fingerprint. Drop
                // the corresponding entry after releasing UserCacheLock so no
                // caller can reuse the retired instance-local id and cache-lock
                // order remains non-nested.
                lock (_seerrCache.UserIdCacheLock)
                {
                    _seerrCache.UserIdCache.Remove(cacheKey);
                }

                _logger.LogWarning(
                    "Discarded a cached Seerr user because its source instance is no longer configured; resolving the user again against current sources.");
            }

            if (cachedResolution != null)
            {
                if (!ConfigurationIsCurrent())
                {
                    return ConfigurationChanged();
                }

                if (cachedResolution.IsFound)
                {
                    ClearAutoImportFailureThrottle(autoImportThrottleKey);
                }

                return cachedResolution;
            }

            var httpClient = SeerrHttpHelper.CreateClient(_httpClientFactory);
            httpClient.Timeout = TimeSpan.FromSeconds(15);
            var normalizedJellyfinUserId = jellyfinUserId.Replace("-", "");
            var usersChecked = 0;
            var hadIncompleteServer = false;
            string? incompleteReason = null;
            foreach (var url in urls)
            {
                cancellationToken.ThrowIfCancellationRequested();
                // Configured Seerr URLs are separate identity domains, not
                // replicas. A complete absence on one server must continue to
                // the next; paginator URL failover alone would stop too early.
                var usersSnapshot = await SeerrPaginationHelper.FetchAllAsync(
                    httpClient,
                    new[] { url },
                    static (baseUrl, _, skip) => $"{baseUrl}/api/v1/user?take=1000&skip={skip}",
                    config.SeerrApiKey,
                    apiUserId: null,
                    requestedPageSize: 1000,
                    UserCollectionIdentity,
                    dispatchFence,
                    cancellationToken).ConfigureAwait(false);

                if (!ConfigurationIsCurrent())
                {
                    return ConfigurationChanged();
                }

                if (!usersSnapshot.IsComplete)
                {
                    if (usersSnapshot.Error != null)
                    {
                        var error = usersSnapshot.Error;
                        _logger.LogWarning(
                            $"Failed to fetch a complete Seerr user collection from {usersSnapshot.SourceUrl}: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}; {usersSnapshot.FailureReason}");
                    }
                    else
                    {
                        _logger.LogWarning(
                            "Failed to fetch a complete Seerr user collection from {Url}: {Reason}",
                            url,
                            usersSnapshot.FailureReason);
                    }

                    // A later server may still hold an explicit mapping (the
                    // historical multi-server failover behavior), but absence
                    // is not authoritative unless every server completed.
                    hadIncompleteServer = true;
                    incompleteReason = usersSnapshot.FailureReason;
                    continue;
                }

                List<SeerrUser> users;
                try
                {
                    users = new List<SeerrUser>(usersSnapshot.Items.Count);
                    foreach (var item in usersSnapshot.Items)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        var candidate = JsonSerializer.Deserialize<SeerrUser>(item.GetRawText());
                        if (candidate == null || candidate.Id <= 0)
                        {
                            throw new JsonException("A Seerr user row did not contain a positive id.");
                        }

                        if (!string.IsNullOrWhiteSpace(candidate.JellyfinUserId))
                        {
                            var canonicalJellyfinUserId = SeerrPaginationHelper.CanonicalJellyfinUserIdentity(
                                candidate.JellyfinUserId);
                            if (canonicalJellyfinUserId == null)
                            {
                                throw new JsonException("A Seerr user row contained a malformed Jellyfin user id.");
                            }

                            candidate.JellyfinUserId = canonicalJellyfinUserId;
                        }

                        candidate.SourceUrl = usersSnapshot.SourceUrl ?? url;
                        users.Add(candidate);
                    }
                }
                catch (JsonException ex)
                {
                    _logger.LogWarning(
                        ex,
                        "A complete Seerr user collection from {Url} contained an invalid user row; refusing a partial lookup result.",
                        usersSnapshot.SourceUrl ?? url);
                    return SeerrUserResolution.Incomplete("The complete user collection contained an invalid row.");
                }

                usersChecked += users.Count;
                var mappedUsers = users
                    .Where(u => string.Equals(u.JellyfinUserId, normalizedJellyfinUserId, StringComparison.OrdinalIgnoreCase))
                    .Take(2)
                    .ToList();
                if (mappedUsers.Count > 1)
                {
                    _logger.LogWarning(
                        "Multiple distinct Seerr users from {Url} map to Jellyfin user {User}; refusing an ambiguous instance-local identity.",
                        usersSnapshot.SourceUrl ?? url,
                        ResolveUserDisplay(jellyfinUserId));
                    return SeerrUserResolution.Incomplete("Multiple Seerr users map to the same Jellyfin user.");
                }

                var user = mappedUsers.SingleOrDefault();
                if (user == null) continue;

                // A successful authoritative lookup supersedes any previous
                // transient auto-import failure for this user.
                ClearAutoImportFailureThrottle(autoImportThrottleKey);

                if (!ConfigurationIsCurrent())
                {
                    return ConfigurationChanged();
                }

                if (cacheEnabled)
                {
                    lock (_seerrCache.UserCacheLock)
                    {
                        _seerrCache.UserCache[cacheKey] = (
                            user,
                            DateTime.UtcNow,
                            configurationRevision,
                            configurationIdentity);
                    }
                }

                if (!ConfigurationIsCurrent())
                {
                    RemovePublishedUserCache(cacheKey, user);
                    return ConfigurationChanged();
                }

                return SeerrUserResolution.Found(user);
            }

            _logger.LogInformation(
                "No matching Jellyfin User ID found after complete reads of {ServerCount} Seerr servers ({UserCount} users).",
                urls.Length,
                usersChecked);

            if (hadIncompleteServer)
            {
                // Never import or negative-cache from a partial cross-server
                // view: the missing server may already contain the mapping.
                return SeerrUserResolution.Incomplete(
                    incompleteReason ?? "At least one Seerr user collection was incomplete.");
            }

            // User not found — attempt just-in-time import into Seerr.
            // `allowAutoImport=false` is passed by read-only callers (e.g. the
            // Permission Audit endpoint, which advertises itself as a non-
            // mutating check). Without this guard, clicking "Run Audit" with
            // auto-import enabled would silently create Seerr users as a side
            // effect — including users an admin may have deliberately kept out
            // of Seerr (but not yet added to the blocklist).
            var importDefinite = false;
            if (allowAutoImport && config.SeerrAutoImportUsers)
            {
                // This operational guard is deliberately independent of the
                // response-cache setting: it never represents absence, it only
                // prevents repeated/concurrent mutation attempts after an
                // incomplete outcome. An explicit bypass forces a retry.
                if (!TryReserveAutoImportAttempt(autoImportThrottleKey, bypassCache))
                {
                    return SeerrUserResolution.Incomplete(
                        "A recent Seerr user import attempt was inconclusive; retry is temporarily throttled.");
                }

                _logger.LogInformation($"User not found in Seerr. Attempting just-in-time import for Jellyfin User ID {ResolveUserDisplay(jellyfinUserId)}...");
                SeerrUser? importedUser;
                bool authoritativeNotImportable;
                try
                {
                    (importedUser, authoritativeNotImportable) = await TryAutoImportSeerrUser(
                        jellyfinUserId,
                        urls,
                        httpClient,
                        config,
                        importConfigStamp,
                        dispatchFence,
                        cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    // Cancellation can arrive after Seerr committed the POST
                    // but before its response reached us. Preserve a short
                    // inconclusive-attempt throttle (including for an explicit
                    // bypass) so another caller cannot immediately replay this
                    // non-idempotent import. The original cancellation still
                    // propagates, and the normal short TTL permits a later retry.
                    if (ConfigurationIsCurrent())
                    {
                        RecordAutoImportFailure(autoImportThrottleKey);
                    }
                    throw;
                }

                if (!ConfigurationIsCurrent())
                {
                    // The POST may have committed just before the generation
                    // changed. Never publish an old-generation throttle after
                    // save-time invalidation; the replacement endpoint is a
                    // distinct identity domain and must be allowed to refetch.
                    return ConfigurationChanged();
                }

                importDefinite = authoritativeNotImportable;
                if (importedUser != null)
                {
                    ClearAutoImportFailureThrottle(autoImportThrottleKey);
                    if (cacheEnabled)
                    {
                        lock (_seerrCache.UserCacheLock)
                        {
                            _seerrCache.UserCache[cacheKey] = (
                                importedUser,
                                DateTime.UtcNow,
                                configurationRevision,
                                configurationIdentity);
                        }
                    }

                    if (!ConfigurationIsCurrent())
                    {
                        RemovePublishedUserCache(cacheKey, importedUser);
                        return ConfigurationChanged();
                    }

                    return SeerrUserResolution.Found(importedUser);
                }

                if (importDefinite)
                {
                    ClearAutoImportFailureThrottle(autoImportThrottleKey);
                }
                else
                {
                    RecordAutoImportFailure(autoImportThrottleKey);
                }
            }

            // Only negative-cache when the import gave a definite "not importable" answer.
            // Transient failures remain Incomplete and use only the separate short retry
            // guard above; they never become authoritative absence.
            if (cacheEnabled && importDefinite)
            {
                if (!ConfigurationIsCurrent())
                {
                    return ConfigurationChanged();
                }

                lock (_seerrCache.UserCacheLock)
                {
                    _seerrCache.UserCache[cacheKey] = (
                        null,
                        DateTime.UtcNow,
                        configurationRevision,
                        configurationIdentity);
                }
            }

            if (!ConfigurationIsCurrent())
            {
                RemovePublishedUserCache(cacheKey, expectedUser: null);
                return ConfigurationChanged();
            }

            _logger.LogWarning($"Could not find or import a matching Seerr user for Jellyfin User ID {ResolveUserDisplay(jellyfinUserId)} after checking all URLs.");
            if (allowAutoImport && config.SeerrAutoImportUsers && !importDefinite)
            {
                return SeerrUserResolution.Incomplete("Seerr user import outcome was not authoritative.");
            }

            return SeerrUserResolution.NotFound();
        }

        private bool TryReserveAutoImportAttempt(string cacheKey, bool bypassThrottle)
        {
            if (bypassThrottle)
            {
                return true;
            }

            lock (_seerrCache.AutoImportFailureThrottleLock)
            {
                var now = DateTime.UtcNow;
                if (_seerrCache.AutoImportFailureThrottle.TryGetValue(cacheKey, out var attemptedAt)
                    && now - attemptedAt < _seerrCache.AutoImportFailureThrottleTtl)
                {
                    return false;
                }

                // Reserve before the asynchronous POST, not after it, so
                // concurrent resolution calls cannot all start imports.
                _seerrCache.AutoImportFailureThrottle[cacheKey] = now;
                return true;
            }
        }

        private void RecordAutoImportFailure(string cacheKey)
        {
            lock (_seerrCache.AutoImportFailureThrottleLock)
            {
                _seerrCache.AutoImportFailureThrottle[cacheKey] = DateTime.UtcNow;
            }
        }

        private void ClearAutoImportFailureThrottle(string cacheKey)
        {
            lock (_seerrCache.AutoImportFailureThrottleLock)
            {
                _seerrCache.AutoImportFailureThrottle.Remove(cacheKey);
            }
        }

        internal static string BuildAutoImportThrottleKey(
            string normalizedJellyfinUserId,
            string generationIdentity)
            => $"{generationIdentity}:{normalizedJellyfinUserId}";

        private async Task<(SeerrUser? User, bool Definite)> TryAutoImportSeerrUser(
            string jellyfinUserId,
            string[] urls,
            HttpClient httpClient,
            PluginConfiguration capturedConfig,
            SeerrMutationConfigStamp configStamp,
            SeerrDispatchFence dispatchFence,
            CancellationToken cancellationToken)
        {
            var apiKey = capturedConfig.SeerrApiKey;

            // Seerr requires dashless UUIDs — dashed format causes empty email and UNIQUE constraint errors
            var normalizedUserId = SeerrPaginationHelper.CanonicalJellyfinUserIdentity(jellyfinUserId);
            if (normalizedUserId == null)
            {
                _logger.LogWarning("Refusing to auto-import a malformed Jellyfin user identity.");
                return (null, true);
            }

            bool ConfigurationIsCurrent()
            {
                var current = _configProvider.ConfigurationOrNull;
                return current != null
                    && configStamp.Matches(current, _configProvider.ConfigurationRevision)
                    && SeerrIntegrationPolicy.HasUsableSavedConfiguration(current)
                    && current.SeerrAutoImportUsers
                    && !IsImportBlocked(normalizedUserId, current);
            }
            SeerrDispatchFence importDispatchFence = dispatchFence.Restrict(ConfigurationIsCurrent);

            var url = urls.FirstOrDefault();
            if (string.IsNullOrWhiteSpace(url))
            {
                return (null, false);
            }

            cancellationToken.ThrowIfCancellationRequested();
            // The absence observed by the caller may be stale by the time the
            // non-idempotent import is ready. Re-read a complete stable map from
            // every configured identity domain, validate its ownership graph,
            // and require the target to remain absent. A target-domain-only
            // check would still create a duplicate when another domain gained
            // the mapping during preparation.
            var dispatchSnapshots = await SeerrPaginationHelper.FetchAllSourcesAsync(
                httpClient,
                urls,
                static (baseUrl, _, skip) => $"{baseUrl}/api/v1/user?take=1000&skip={skip}",
                apiKey,
                apiUserId: null,
                requestedPageSize: 1000,
                UserCollectionIdentity,
                importDispatchFence,
                cancellationToken).ConfigureAwait(false);
            if (!dispatchSnapshots.IsComplete)
            {
                _logger.LogWarning(
                    "Refusing Seerr auto-import because its final all-domain user-map proof was incomplete or invalid: {Reason}",
                    dispatchSnapshots.FailureReason);
                return (null, false);
            }

            if (!SeerrUserImportHelper.TryCollectMappedUserIds(
                    dispatchSnapshots,
                    out var mappedUserIds,
                    out var mapFailure))
            {
                _logger.LogWarning(
                    "Refusing Seerr auto-import because its final all-domain user-map proof was incomplete or invalid: {Reason}",
                    mapFailure);
                return (null, false);
            }

            if (mappedUserIds.Contains(normalizedUserId))
            {
                _logger.LogInformation(
                    "Refusing Seerr auto-import because the Jellyfin user became linked during preparation; a fresh resolution is required.");
                return (null, false);
            }

            var currentConfig = _configProvider.ConfigurationOrNull;
            if (!configStamp.Matches(currentConfig, _configProvider.ConfigurationRevision)
                || currentConfig == null
                || !SeerrIntegrationPolicy.HasUsableSavedConfiguration(currentConfig)
                || !currentConfig.SeerrAutoImportUsers
                || IsImportBlocked(normalizedUserId, currentConfig))
            {
                _logger.LogInformation(
                    "Refusing Seerr auto-import because its configuration or authorization changed during preparation.");
                return (null, false);
            }

            cancellationToken.ThrowIfCancellationRequested();
            // User creation is not idempotent. Configured URLs are distinct
            // identity domains rather than failover replicas, and no source
            // binding exists for a user that was absent from every domain.
            // Deterministically select one normalized configured endpoint and
            // never replay the POST elsewhere after any outcome: a timeout,
            // reset, HTTP error, HTML response, or malformed body may follow a
            // committed import even though this caller cannot prove it.
            try
            {
                if (!importDispatchFence.CanDispatch())
                {
                    return (null, false);
                }

                var importUri = $"{url}/api/v1/user/import-from-jellyfin";
                var requestBody = JsonSerializer.Serialize(new { jellyfinUserIds = new[] { normalizedUserId } });

                using var importRequest = SeerrHttpHelper.BuildRequest(HttpMethod.Post, importUri, apiKey, bodyJson: requestBody);
                var (importJson, importError, _) = await SeerrHttpHelper.SendAndReadJsonAsync(
                    httpClient,
                    importRequest,
                    importUri,
                    importDispatchFence,
                    cancellationToken).ConfigureAwait(false);

                if (importError != null)
                {
                    // Email collision is a definite failure — a renamed/deleted Jellyfin user left
                    // an orphaned Seerr account with the same email. Won't resolve on retry.
                    if (!string.IsNullOrEmpty(importError.Message)
                        && importError.Message.Contains("UNIQUE constraint failed: user.email", StringComparison.OrdinalIgnoreCase))
                    {
                        _logger.LogWarning($"Could not auto-import Jellyfin User ID {ResolveUserDisplay(jellyfinUserId)}: an existing Seerr account has a conflicting email (possibly from a previous user that was renamed or deleted). Remove the conflicting user in Seerr to resolve this.");
                        return (null, true);
                    }

                    _logger.LogWarning($"Failed to auto-import user to Seerr at {url}: code={importError.Code} status={importError.HttpStatus} cf-ray={importError.CfRay} — {importError.Message}");
                    return (null, false);
                }

                // The import endpoint returns an array of newly created users.
                // Parse it directly to avoid a second API call.
                var importedUsers = JsonSerializer.Deserialize<List<SeerrUser>>(importJson!);
                if (importedUsers == null)
                {
                    _logger.LogWarning("Auto-import response at {Url} was not a user array.", url);
                    return (null, false);
                }

                var importedMatches = importedUsers
                    .Where(u => u != null && string.Equals(
                        SeerrPaginationHelper.CanonicalJellyfinUserIdentity(u.JellyfinUserId),
                        normalizedUserId,
                        StringComparison.OrdinalIgnoreCase))
                    .Take(2)
                    .ToList();
                if (importedMatches.Count > 1)
                {
                    _logger.LogWarning(
                        "Auto-import response at {Url} contained multiple users mapped to Jellyfin user {User}; the import outcome is ambiguous.",
                        url,
                        ResolveUserDisplay(jellyfinUserId));
                    return (null, false);
                }

                var user = importedMatches.SingleOrDefault();
                if (user != null)
                {
                    if (user.Id <= 0)
                    {
                        _logger.LogWarning("Auto-import response at {Url} contained an invalid user id.", url);
                        return (null, false);
                    }

                    user.JellyfinUserId = normalizedUserId;
                    user.SourceUrl = url;
                    _logger.LogInformation($"Auto-imported Seerr user ID {user.Id} for Jellyfin User {ResolveUserDisplay(jellyfinUserId)}");
                    return (user, true);
                }

                // Some Seerr versions return an empty array even on success (user already existed
                // but wasn't in the import response). Fall back to a full user list query to find them.
                _logger.LogInformation($"Import succeeded at {url} but user not in response. Doing fresh lookup...");
                var freshSnapshot = await SeerrPaginationHelper.FetchAllAsync(
                    httpClient,
                    new[] { url },
                    static (baseUrl, _, skip) => $"{baseUrl}/api/v1/user?take=1000&skip={skip}",
                    apiKey,
                    apiUserId: null,
                    requestedPageSize: 1000,
                    UserCollectionIdentity,
                    importDispatchFence,
                    cancellationToken).ConfigureAwait(false);
                if (freshSnapshot.IsComplete)
                {
                    try
                    {
                        var allUsers = new List<SeerrUser>(freshSnapshot.Items.Count);
                        foreach (var item in freshSnapshot.Items)
                        {
                            cancellationToken.ThrowIfCancellationRequested();
                            var candidate = JsonSerializer.Deserialize<SeerrUser>(item.GetRawText());
                            if (candidate == null || candidate.Id <= 0)
                            {
                                throw new JsonException("A Seerr user row did not contain a positive id.");
                            }

                            if (!string.IsNullOrWhiteSpace(candidate.JellyfinUserId))
                            {
                                var canonicalJellyfinUserId = SeerrPaginationHelper.CanonicalJellyfinUserIdentity(
                                    candidate.JellyfinUserId);
                                if (canonicalJellyfinUserId == null)
                                {
                                    throw new JsonException("A Seerr user row contained a malformed Jellyfin user id.");
                                }

                                candidate.JellyfinUserId = canonicalJellyfinUserId;
                            }

                            allUsers.Add(candidate);
                        }

                        var freshMatches = allUsers
                            .Where(u => string.Equals(u.JellyfinUserId, normalizedUserId, StringComparison.OrdinalIgnoreCase))
                            .Take(2)
                            .ToList();
                        if (freshMatches.Count > 1)
                        {
                            _logger.LogWarning(
                                "Fresh Seerr lookup at {Url} found multiple users mapped to Jellyfin user {User}; the import outcome is ambiguous.",
                                url,
                                ResolveUserDisplay(jellyfinUserId));
                            return (null, false);
                        }

                        var found = freshMatches.SingleOrDefault();
                        if (found != null)
                        {
                            found.SourceUrl = url;
                            _logger.LogInformation($"Found Seerr user ID {found.Id} for Jellyfin User {ResolveUserDisplay(jellyfinUserId)} via fresh lookup");
                            return (found, true);
                        }
                    }
                    catch (JsonException ex)
                    {
                        _logger.LogWarning(
                            ex,
                            "Fresh Seerr user lookup at {Url} contained an invalid row; the import outcome is not definite.",
                            url);
                        return (null, false);
                    }

                    // Import succeeded and a complete fresh lookup found
                    // nothing: the user is genuinely not importable.
                    return (null, true);
                }

                _logger.LogWarning(
                    "Fresh Seerr user lookup at {Url} was incomplete after import; refusing to publish or cache an absence: {Reason}",
                    url,
                    freshSnapshot.FailureReason);
                return (null, false);
            }
            catch (HttpRequestException ex)
            {
                _logger.LogDebug($"Connection error during auto-import for Jellyfin User {ResolveUserDisplay(jellyfinUserId)} at {url}: {ex.Message}");
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (OperationCanceledException ex)
            {
                _logger.LogWarning(
                    "Timed out while auto-importing Jellyfin user {User} at {Url}: {Message}",
                    ResolveUserDisplay(jellyfinUserId),
                    url,
                    ex.Message);
            }
            catch (JsonException ex)
            {
                _logger.LogWarning($"Invalid response from Seerr during auto-import for Jellyfin User {ResolveUserDisplay(jellyfinUserId)} at {url}: {ex.Message}");
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    "Unexpected auto-import failure for Jellyfin user {User} at {Url}: {Type}: {Message}",
                    ResolveUserDisplay(jellyfinUserId),
                    url,
                    ex.GetType().Name,
                    ex.Message);
            }

            // A generic HTTP error, malformed body, timeout, or transport failure
            // says nothing authoritative about whether the user is importable.
            // Only the explicit collision case or a successful import followed by
            // a complete fresh absence may be negative-cached.
            return (null, false);
        }

        public async Task<string?> GetSeerrUserId(string jellyfinUserId, bool allowAutoImport = true)
        {
            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            if (!integration.IsActive)
            {
                return null;
            }

            var config = integration.Configuration!;
            var configurationRevision = integration.ConfigurationRevision;
            var configurationIdentity = BuildConfigurationIdentity(config);
            var configStamp = SeerrMutationConfigStamp.Capture(config, configurationRevision);
            bool ConfigurationIsCurrent() => integration.IsCurrent(_configProvider)
                && configStamp.Matches(
                    _configProvider.ConfigurationOrNull,
                    _configProvider.ConfigurationRevision);
            bool cacheEnabled = !config.SeerrDisableCache;
            var cacheKey = NormalizeUserId(jellyfinUserId);

            if (!ConfigurationIsCurrent())
            {
                return null;
            }

            // Check cache first (unless disabled)
            if (cacheEnabled)
            {
                lock (_seerrCache.UserIdCacheLock)
                {
                    if (_seerrCache.UserIdCache.TryGetValue(cacheKey, out var cached) &&
                        cached.ConfigurationRevision == configurationRevision &&
                        string.Equals(
                            cached.ConfigurationIdentity,
                            configurationIdentity,
                            StringComparison.Ordinal) &&
                        DateTime.UtcNow - cached.CachedAt < _seerrCache.GetUserIdCacheTtl())
                    {
                        return ConfigurationIsCurrent() ? cached.SeerrUserId : null;
                    }

                    if (_seerrCache.UserIdCache.TryGetValue(cacheKey, out cached)
                        && (cached.ConfigurationRevision != configurationRevision
                            || !string.Equals(
                                cached.ConfigurationIdentity,
                                configurationIdentity,
                                StringComparison.Ordinal)))
                    {
                        _seerrCache.UserIdCache.Remove(cacheKey);
                    }
                }
            }

            var user = await GetSeerrUser(jellyfinUserId, allowAutoImport: allowAutoImport);
            var seerrUserId = user?.Id.ToString();
            if (!ConfigurationIsCurrent())
            {
                return null;
            }

            if (!string.IsNullOrEmpty(seerrUserId) && cacheEnabled)
            {
                var publishedEntry = (
                    SeerrUserId: seerrUserId,
                    CachedAt: DateTime.UtcNow,
                    ConfigurationRevision: configurationRevision,
                    ConfigurationIdentity: configurationIdentity);
                lock (_seerrCache.UserIdCacheLock)
                {
                    _seerrCache.UserIdCache[cacheKey] = publishedEntry;
                }

                if (!ConfigurationIsCurrent())
                {
                    lock (_seerrCache.UserIdCacheLock)
                    {
                        if (_seerrCache.UserIdCache.TryGetValue(cacheKey, out var published)
                            && published.Equals(publishedEntry))
                        {
                            _seerrCache.UserIdCache.Remove(cacheKey);
                        }
                    }

                    return null;
                }
            }

            return seerrUserId;
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
            // Query-string-form discovery (the shape JC actually emits).
            // Discovery responses include media.requests/requestedBy etc.
            // BUT the proxy uses X-Api-User header to filter requestedBy
            // server-side, so the body is per-user — except for very simple
            // shapes (no requestedBy filter, no language). Keep these
            // per-user to be safe; only the truly content-only TMDB sliders
            // and direct genre/keyword/person lookups are shared.
            if (apiPath.StartsWith("/api/v1/genres/", StringComparison.OrdinalIgnoreCase)) return true;
            // Only the bare person-detail route is user-neutral. Seerr's
            // /person/{id}/combined_credits route joins Media through req.user
            // and serializes user-local mediaInfo/watchlist state, so treating
            // every /person/* path as public would cache one user's projection
            // for every caller.
            var personPath = apiPath.Split('?', 2)[0].TrimEnd('/');
            const string personPrefix = "/api/v1/person/";
            if (personPath.StartsWith(personPrefix, StringComparison.OrdinalIgnoreCase))
            {
                var personResource = personPath[personPrefix.Length..];
                if (int.TryParse(
                        personResource,
                        System.Globalization.NumberStyles.None,
                        System.Globalization.CultureInfo.InvariantCulture,
                        out var personId)
                    && personId > 0)
                {
                    return true;
                }
            }
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
                EvictMediaDetailCache(mediaIdEl.GetInt32(), mediaTypeEl.GetString() ?? string.Empty);
            }
            catch { /* best-effort eviction */ }
        }

        /// <inheritdoc />
        public void EvictMediaDetailCache(int tmdbId, string mediaType)
        {
            if (mediaType != "movie" && mediaType != "tv") return;
            // User-scoped cache keys end with
            // `{jellyfinUserId}:{seerrUserId}:{apiPath}` (after a
            // source-identity prefix). We want to match
            // EITHER the bare detail (apiPath ends with `/api/v1/movie/12`)
            // OR a sub-path (apiPath starts with `/api/v1/movie/12/` —
            // for `/similar`, `/recommendations`, `/season/1`, etc).
            var bareSuffix = $":/api/v1/{mediaType}/{tmdbId}";
            var subPathInfix = $":/api/v1/{mediaType}/{tmdbId}/";
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

        internal static bool TryPublishResponseCacheEntry(
            Helpers.BoundedTtlCache<string, (string Content, DateTime CachedAt, long ConfigurationRevision, string ConfigurationIdentity)> cache,
            object cacheLock,
            string cacheKey,
            (string Content, DateTime CachedAt, long ConfigurationRevision, string ConfigurationIdentity) entry,
            SeerrDispatchFence dispatchFence)
        {
            if (!dispatchFence.CanDispatch())
            {
                return false;
            }

            Helpers.BoundedTtlCache<string, (string Content, DateTime CachedAt, long ConfigurationRevision, string ConfigurationIdentity)>.CacheToken publication;
            lock (cacheLock)
            {
                cache.TrySet(cacheKey, entry, out publication);
            }

            if (dispatchFence.CanDispatch())
            {
                return true;
            }

            // Remove only the tuple this flight published. A newer same-key
            // refresh can win between publication and the post-write fence and
            // must not be deleted by stale cleanup.
            lock (cacheLock)
            {
                cache.Remove(publication);
            }

            return false;
        }

        /// <summary>
        /// Applies the parental-rating filter to a response body and turns the
        /// outcome into a result: a bare 403 when a restricted caller reached a
        /// blocked detail/season body, otherwise the (possibly list-filtered) JSON.
        /// </summary>
        private async Task<IActionResult> ApplyParentalFilterAsync(string body, string apiPath, SeerrCaller caller)
        {
            var result = await _parentalFilter.ApplyAsync(body, apiPath, caller);
            if (result.Block)
            {
                return new StatusCodeResult(403);
            }

            if (!result.Succeeded)
            {
                // ApplyAsync deliberately carries the raw body only as a
                // diagnostic/legacy fallback when filtering faults. Returning
                // it here would disclose the unfiltered cache/upstream payload
                // to a restricted caller, so ordinary proxy reads fail closed.
                return new ObjectResult(new
                {
                    error = true,
                    code = "parental_filter_unavailable",
                    message = "Parental filtering could not be completed. Please try again."
                })
                { StatusCode = 503 };
            }

            return new ContentResult { Content = result.Body, ContentType = "application/json" };
        }

        /// <summary>
        /// True when a Seerr request POST body carries a truthy <c>is4k</c>. Treats
        /// JSON <c>true</c>, a nonzero number, and the strings "true"/"1"
        /// (case-insensitive) all as 4K — so a crafted <c>{"is4k":1}</c> or
        /// <c>{"is4k":"true"}</c> can't dodge the 4K master switch / permission
        /// gates by slipping past a strict <c>== true</c> check and falling through
        /// to Seerr.
        /// </summary>
        private static bool TryGetIs4k(string content)
        {
            try
            {
                using var doc = JsonDocument.Parse(content);
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object
                    || !root.TryGetProperty("is4k", out var is4k))
                {
                    return false;
                }

                switch (is4k.ValueKind)
                {
                    case JsonValueKind.True:
                        return true;
                    case JsonValueKind.False:
                    case JsonValueKind.Null:
                        return false;
                    case JsonValueKind.Number:
                        return is4k.TryGetDouble(out var n) && n != 0;
                    case JsonValueKind.String:
                        var s = is4k.GetString();
                        return string.Equals(s, "true", StringComparison.OrdinalIgnoreCase)
                            || string.Equals(s, "1", StringComparison.OrdinalIgnoreCase);
                    default:
                        return false;
                }
            }
            catch (JsonException)
            {
                return false;
            }
        }

        /// <summary>Reads mediaType + tmdbId (the <c>mediaId</c> field) from a Seerr request POST body.</summary>
        private static bool TryGetRequestMedia(string content, out string mediaType, out int tmdbId)
        {
            mediaType = "movie";
            tmdbId = 0;
            try
            {
                using var doc = JsonDocument.Parse(content);
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object)
                {
                    return false;
                }

                if (root.TryGetProperty("mediaType", out var mt) && mt.ValueKind == JsonValueKind.String)
                {
                    mediaType = string.Equals(mt.GetString(), "tv", StringComparison.OrdinalIgnoreCase) ? "tv" : "movie";
                }

                if (root.TryGetProperty("mediaId", out var mediaId))
                {
                    if (mediaId.ValueKind == JsonValueKind.Number && mediaId.TryGetInt32(out tmdbId))
                    {
                        return tmdbId > 0;
                    }

                    if (mediaId.ValueKind == JsonValueKind.String
                        && int.TryParse(mediaId.GetString(), System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out tmdbId))
                    {
                        return tmdbId > 0;
                    }
                }

                return false;
            }
            catch (JsonException)
            {
                return false;
            }
        }

        public Task<IActionResult> ProxyRequestAsync(
            string apiPath,
            HttpMethod method,
            string? content,
            SeerrCaller caller)
            => ProxyRequestAsyncCore(apiPath, method, content, caller, resolvedUser: null, CancellationToken.None);

        public Task<IActionResult> ProxyRequestAsync(
            string apiPath,
            HttpMethod method,
            string? content,
            SeerrCaller caller,
            CancellationToken cancellationToken)
            => ProxyRequestAsyncCore(apiPath, method, content, caller, resolvedUser: null, cancellationToken);

        public Task<IActionResult> ProxyRequestAsync(
            string apiPath,
            HttpMethod method,
            string? content,
            SeerrCaller caller,
            SeerrUser resolvedUser)
            => ProxyRequestAsyncCore(apiPath, method, content, caller, resolvedUser, CancellationToken.None);

        public Task<IActionResult> ProxyRequestAsync(
            string apiPath,
            HttpMethod method,
            string? content,
            SeerrCaller caller,
            SeerrUser resolvedUser,
            CancellationToken cancellationToken)
            => ProxyRequestAsyncCore(apiPath, method, content, caller, resolvedUser, cancellationToken);

        public Task<IActionResult> ProxyFreshTvDetailAsync(
            int tmdbId,
            SeerrCaller caller,
            CancellationToken cancellationToken = default)
        {
            if (tmdbId <= 0)
            {
                return Task.FromResult<IActionResult>(
                    new BadRequestObjectResult(new
                    {
                        error = true,
                        code = "invalid_tmdb_id",
                        message = "A positive TMDB ID is required."
                    }));
            }

            return ProxyRequestAsyncCore(
                $"/api/v1/tv/{tmdbId}",
                HttpMethod.Get,
                content: null,
                caller,
                resolvedUser: null,
                cancellationToken,
                bypassResponseCache: true);
        }

        public Task<IActionResult> ProxyFreshMediaDetailAsync(
            int tmdbId,
            string mediaType,
            SeerrCaller caller,
            SeerrUser resolvedUser,
            CancellationToken cancellationToken = default)
        {
            var normalizedType = mediaType?.Trim().ToLowerInvariant();
            if (tmdbId <= 0 || normalizedType is not ("movie" or "tv"))
            {
                return Task.FromResult<IActionResult>(
                    new BadRequestObjectResult(new
                    {
                        error = true,
                        code = "invalid_media_target",
                        message = "A positive TMDB ID and media type movie/tv are required."
                    }));
            }

            return ProxyRequestAsyncCore(
                $"/api/v1/{normalizedType}/{tmdbId}",
                HttpMethod.Get,
                content: null,
                caller,
                resolvedUser,
                cancellationToken,
                bypassResponseCache: true,
                requireIssueViewPermission: true);
        }

        private async Task<IActionResult> ProxyRequestAsyncCore(
            string apiPath,
            HttpMethod method,
            string? content,
            SeerrCaller caller,
            SeerrUser? resolvedUser,
            CancellationToken cancellationToken,
            bool bypassResponseCache = false,
            bool requireIssueViewPermission = false)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            if (!integration.IsActive)
            {
                _logger.LogWarning("Seerr integration is not configured or enabled.");
                return new ObjectResult("Seerr integration is not configured or enabled.") { StatusCode = 503 };
            }

            var config = integration.Configuration!;
            var requestConfigurationRevision = integration.ConfigurationRevision;
            var requestConfigurationIdentity = BuildConfigurationIdentity(config);
            var requestConfigStamp = SeerrMutationConfigStamp.Capture(
                config,
                requestConfigurationRevision);
            SeerrDispatchFence requestDispatchFence = integration
                .CreateDispatchFence(_configProvider)
                .Restrict(() => requestConfigStamp.Matches(
                    _configProvider.ConfigurationOrNull,
                    _configProvider.ConfigurationRevision));
            var mutationConfigStamp = method != HttpMethod.Get
                ? requestConfigStamp
                : (SeerrMutationConfigStamp?)null;
            var isPublicScope = method == HttpMethod.Get && IsPublicScopeApiPath(apiPath);

            // The caller identity is resolved by the controller from the
            // authenticated principal (never caller-controlled headers).
            var jellyfinUserId = caller.JellyfinUserId;
            if (string.IsNullOrEmpty(jellyfinUserId))
            {
                _logger.LogWarning("Could not resolve Jellyfin user ID from the authenticated principal.");
                return new ForbidResult();
            }

            // Resolve once unless the caller already carries the exact
            // instance-local user context. A supplied user must have a source
            // that is still configured: falling back here could replay its
            // numeric id against another Seerr instance.
            SeerrUserResolution userResolution;
            string? pinnedSourceUrl = null;
            if (resolvedUser != null)
            {
                pinnedSourceUrl = FindConfiguredSource(
                    GetConfiguredUrls(config.SeerrUrls),
                    resolvedUser.SourceUrl);
                if (resolvedUser.Id <= 0 || pinnedSourceUrl == null)
                {
                    _logger.LogWarning(
                        "Refusing a pre-resolved Seerr request because its instance-local user context is invalid or no longer configured.");
                    return new ObjectResult(new
                    {
                        error = true,
                        code = "source_affinity_unavailable",
                        message = "The linked Seerr instance could not be verified. Please try again."
                    })
                    { StatusCode = 502 };
                }

                if (method == HttpMethod.Get && !isPublicScope)
                {
                    // A positive cache entry cannot authorize user-local data:
                    // the same instance-local id may have been rebound from
                    // Jellyfin user A to B without changing the source URL.
                    // Validate the caller's exact pinned binding against a
                    // fresh complete all-domain snapshot before using an API
                    // path that was built from that id (for example quota).
                    var freshUser = await FetchExactUserBindingAsync(
                        jellyfinUserId,
                        resolvedUser.Id,
                        pinnedSourceUrl,
                        config.SeerrApiKey,
                        requestDispatchFence,
                        cancellationToken).ConfigureAwait(false);
                    if (freshUser == null
                        || freshUser.Id != resolvedUser.Id
                        || !string.Equals(
                            SeerrUrlIdentity.Normalize(freshUser.SourceUrl),
                            pinnedSourceUrl,
                            StringComparison.Ordinal))
                    {
                        InvalidateUserIdentityCache(jellyfinUserId);

                        _logger.LogWarning(
                            "Refusing a user-scoped Seerr read because its supplied user binding changed before dispatch.");
                        return new ObjectResult(new
                        {
                            error = true,
                            code = "user_binding_changed",
                            message = "Your linked Seerr identity changed. Please try again."
                        })
                        { StatusCode = 409 };
                    }

                    freshUser.SourceUrl = pinnedSourceUrl;
                    userResolution = SeerrUserResolution.Found(freshUser);
                }
                else
                {
                    userResolution = SeerrUserResolution.Found(resolvedUser);
                }
            }
            else
            {
                // Resolve the Seerr user ONCE up-front and reuse for both
                // ID-extraction and the non-admin permission check below.
                userResolution = await ResolveSeerrUser(
                    jellyfinUserId,
                    bypassCache: method == HttpMethod.Get && !isPublicScope,
                    allowAutoImport: !(method == HttpMethod.Get && !isPublicScope),
                    cancellationToken: cancellationToken).ConfigureAwait(false);
            }

            var seerrUser = userResolution.User;
            var seerrUserId = seerrUser?.Id.ToString();
            if (!userResolution.IsFound || string.IsNullOrEmpty(seerrUserId))
            {
                _logger.LogWarning(
                    "Could not resolve a Seerr user for Jellyfin user {User}: {Status}; {Reason}",
                    ResolveUserDisplay(jellyfinUserId),
                    userResolution.Status,
                    userResolution.FailureReason);

                if (userResolution.Status == SeerrUserResolutionStatus.Incomplete)
                {
                    return new ObjectResult(new
                    {
                        error = true,
                        code = "user_lookup_incomplete",
                        message = "Seerr returned an incomplete user collection. Please try again."
                    })
                    { StatusCode = 502 };
                }

                if (userResolution.Status == SeerrUserResolutionStatus.Unavailable)
                {
                    return new ObjectResult(new
                    {
                        error = true,
                        code = "unavailable",
                        message = "Seerr integration is not available."
                    })
                    { StatusCode = 503 };
                }

                if (userResolution.Status == SeerrUserResolutionStatus.Blocked)
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
                    message = "Current Jellyfin user is not linked to a Seerr user."
                });
            }

            // JC 4K master switch (applies to EVERY caller, admins included): when
            // the admin has disabled 4K requests for this media type, no 4K request
            // may be submitted through JC. The client hides the option; this enforces
            // it server-side so a crafted POST with is4k can't bypass the toggle the
            // docs describe as a master switch.
            if (method == HttpMethod.Post
                && apiPath.StartsWith("/api/v1/request", StringComparison.OrdinalIgnoreCase)
                && content != null
                && TryGetIs4k(content))
            {
                bool isTv4k = TryGetRequestMedia(content, out var mtSwitch, out _)
                    && string.Equals(mtSwitch, "tv", StringComparison.OrdinalIgnoreCase);
                bool adminEnabled = isTv4k ? config.SeerrEnable4KTvRequests : config.SeerrEnable4KRequests;
                if (!adminEnabled)
                    return new ObjectResult(new { code = "4k_requests_disabled", message = "4K requests are disabled." }) { StatusCode = 403 };
            }

            // Enforce Seerr permissions for write operations and sensitive reads.
            // Jellyfin admins bypass all permission checks (they can do anything in Seerr).
            // For non-admins, validate before proxying so we return a clear 403 rather than
            // letting Seerr reject the request with a generic error.
            if (!caller.IsAdmin)
            {
                // reuse the Seerr user we already resolved above — no second
                // GetSeerrUser call.
                if (seerrUser != null)
                {
                    var perms = seerrUser.Permissions;
                    bool isSeerrAdmin = SeerrPermissionHelper.HasPermission(perms, SeerrPermission.ADMIN);

                    if (!isSeerrAdmin)
                    {
                        // POST /api/v1/request — make a request
                        if (method == HttpMethod.Post && apiPath.StartsWith("/api/v1/request", StringComparison.OrdinalIgnoreCase))
                        {
                            // Seerr fully decouples the 4K permission bits from the
                            // base request bits (server/entity/MediaRequest.ts:80-112):
                            // a user holding only REQUEST_4K / REQUEST_4K_MOVIE /
                            // REQUEST_4K_TV may submit a 4K request without ANY base
                            // REQUEST / REQUEST_MOVIE / REQUEST_TV bit. So for a 4K
                            // request we SKIP the base precondition and gate solely on
                            // the 4K helper; only the non-4K path requires a base bit.
                            if (content != null && TryGetIs4k(content))
                            {
                                bool isTv = TryGetRequestMedia(content, out var mt4k, out _)
                                    && string.Equals(mt4k, "tv", StringComparison.OrdinalIgnoreCase);
                                if (!SeerrPermissionHelper.CanRequest4k(perms, isTv))
                                    return new ObjectResult(new { code = "no_4k_request_permission", message = "You do not have permission to request 4K in Seerr." }) { StatusCode = 403 };
                            }
                            else if (!SeerrPermissionHelper.HasAnyPermission(perms,
                                SeerrPermission.REQUEST | SeerrPermission.REQUEST_MOVIE | SeerrPermission.REQUEST_TV))
                            {
                                return new ObjectResult(new { code = "no_request_permission", message = "You do not have permission to make requests in Seerr." }) { StatusCode = 403 };
                            }
                        }

                        // POST /api/v1/issue — report an issue
                        if (method == HttpMethod.Post && apiPath.StartsWith("/api/v1/issue", StringComparison.OrdinalIgnoreCase))
                        {
                            if (!SeerrPermissionHelper.HasAnyPermission(perms,
                                SeerrPermission.CREATE_ISSUES | SeerrPermission.MANAGE_ISSUES))
                                return new ObjectResult(new { code = "no_issue_permission", message = "You do not have permission to report issues in Seerr." }) { StatusCode = 403 };
                        }

                        // GET /api/v1/issue — view issues list (any of: ?query, exact, /id)
                        // The /api/v1/issue/{id} path was previously not gated by this
                        // check.— non-admin without VIEW_ISSUES could
                        // fetch any issue by id by guessing.
                        if (method == HttpMethod.Get && (requireIssueViewPermission
                            || apiPath.StartsWith("/api/v1/issue?", StringComparison.OrdinalIgnoreCase)
                            || apiPath.StartsWith("/api/v1/issue/", StringComparison.OrdinalIgnoreCase)
                            || string.Equals(apiPath, "/api/v1/issue", StringComparison.OrdinalIgnoreCase)))
                        {
                            if (!SeerrPermissionHelper.HasAnyPermission(perms,
                                SeerrPermission.VIEW_ISSUES | SeerrPermission.MANAGE_ISSUES))
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
                            if (!SeerrPermissionHelper.HasAnyPermission(perms,
                                SeerrPermission.REQUEST_ADVANCED | SeerrPermission.MANAGE_REQUESTS))
                                return new ObjectResult(new { code = "no_advanced_permission", message = "You do not have permission to use advanced request options." }) { StatusCode = 403 };
                        }
                    }
                }
            }

            // Parental-rating gate on request POSTs: a rating-limited user must not
            // be able to request a title above their limit even by tmdbId (the
            // whole point of the filter — "media they can't watch once requested").
            // Admins / no-limit users are passed through inside the filter. A body
            // we cannot parse resolves to tmdbId 0, which IsBlockedAsync fails closed
            // for restricted callers — so an unrecognized request shape can't bypass.
            if (method == HttpMethod.Post
                && apiPath.StartsWith("/api/v1/request", StringComparison.OrdinalIgnoreCase)
                && content != null)
            {
                var reqMediaType = TryGetRequestMedia(content, out var mt, out var id) ? mt : "movie";
                var reqTmdbId = id;
                if (await _parentalFilter.IsBlockedAsync(reqMediaType, reqTmdbId, caller))
                {
                    _logger.LogInformation($"Blocked a Seerr request for {reqMediaType}/{reqTmdbId} by user {ResolveUserDisplay(jellyfinUserId)} — exceeds their parental rating limit or could not be verified.");
                    return new StatusCodeResult(403);
                }
            }

            var configuredUrls = GetConfiguredUrls(config.SeerrUrls);
            // Only safe GETs may use the public cache/failover path. A future
            // controller must not accidentally replay a write merely because
            // its URL resembles a user-neutral metadata endpoint.
            string? boundSourceUrl = null;
            if (!isPublicScope)
            {
                boundSourceUrl = FindConfiguredSource(
                    configuredUrls,
                    pinnedSourceUrl ?? seerrUser!.SourceUrl);
                if (boundSourceUrl == null)
                {
                    _logger.LogWarning(
                        "Refusing a user-scoped Seerr request because its resolved source is missing or no longer configured.");
                    return new ObjectResult(new
                    {
                        error = true,
                        code = "source_affinity_unavailable",
                        message = "The linked Seerr instance could not be verified. Please try again."
                    })
                    { StatusCode = 502 };
                }
            }

            // Check server-side response cache for cacheable endpoints.
            // bifurcate cache key. Public discovery
            // endpoints return identical content for all users, so include the
            // user-id in the key only for endpoints whose response actually
            // varies per-user (mediaInfo.requests, watchlist, partial-requests
            // setting, requested-by-me filters, etc).
            bool isCacheable = !bypassResponseCache
                && IsCacheableApiPath(apiPath, method)
                && !config.SeerrDisableCache;
            var responseCacheGenerationPrefix = $"cfg:{requestConfigurationIdentity}:";
            var cacheKey = isPublicScope
                ? $"{responseCacheGenerationPrefix}public:{apiPath}"
                // A Jellyfin account can be unlinked/re-imported as a different
                // instance-local Seerr user without changing either its caller
                // id or source URL. Include that current Seerr id so a cached
                // user-local body can never survive such a same-source rebind.
                : $"{responseCacheGenerationPrefix}{boundSourceUrl!.Length}:{boundSourceUrl}:{jellyfinUserId}:{seerrUserId}:{apiPath}";
            if (isCacheable)
            {
                string? cachedContent = null;
                lock (_seerrCache.ResponseCacheLock)
                {
                    if (_seerrCache.ResponseCache.TryGetValue(cacheKey, out var cached) &&
                        cached.ConfigurationRevision == requestConfigurationRevision &&
                        string.Equals(
                            cached.ConfigurationIdentity,
                            requestConfigurationIdentity,
                            StringComparison.Ordinal) &&
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
                    var filtered = await ApplyParentalFilterAsync(cachedContent, apiPath, caller).ConfigureAwait(false);
                    cancellationToken.ThrowIfCancellationRequested();
                    if (!requestConfigStamp.Matches(
                            _configProvider.ConfigurationOrNull,
                            _configProvider.ConfigurationRevision))
                    {
                        return new ObjectResult(new
                        {
                            error = true,
                            code = "read_configuration_changed",
                            message = "Seerr configuration changed while preparing the response. Please try again."
                        })
                        { StatusCode = 409 };
                    }

                    return filtered;
                }
            }

            // Seerr user ids are instance-local. Public endpoints carry no
            // X-Api-User and may use normal URL failover; every user-scoped read
            // or mutation stays on the instance that resolved this user.
            var urls = isPublicScope
                ? configuredUrls
                : new[] { boundSourceUrl! };

            if (method == HttpMethod.Get
                && !requestConfigStamp.Matches(
                    _configProvider.ConfigurationOrNull,
                    _configProvider.ConfigurationRevision))
            {
                return new ObjectResult(new
                {
                    error = true,
                    code = "read_configuration_changed",
                    message = "Seerr configuration changed while preparing the request. Please try again."
                })
                { StatusCode = 409 };
            }

            if (method != HttpMethod.Get)
            {
                // The normal resolver cache is useful for reads, but a Seerr
                // numeric user id and its permissions can be revoked/rebound
                // during its TTL. Re-resolve immediately before dispatch and
                // require the exact binding that all checks above used. Never
                // auto-import here: that is another non-idempotent mutation and
                // must not be coupled to replay of the requested write.
                var freshResolution = await ResolveSeerrUser(
                    jellyfinUserId,
                    bypassCache: true,
                    allowAutoImport: false,
                    cancellationToken: cancellationToken).ConfigureAwait(false);

                // Configuration saves replace the live object while the fresh
                // identity lookup is in flight. Never dispatch with the stale
                // URLs, API key, feature gates, parental policy, or request
                // settings that authorized the write. The complete digest also
                // catches a test/custom provider mutating an object in place.
                var currentMutationConfig = _configProvider.ConfigurationOrNull;
                if (!mutationConfigStamp.HasValue
                    || !mutationConfigStamp.Value.Matches(
                        currentMutationConfig,
                        _configProvider.ConfigurationRevision)
                    || currentMutationConfig == null
                    || !SeerrIntegrationPolicy.HasUsableSavedConfiguration(currentMutationConfig))
                {
                    return new ObjectResult(new
                    {
                        error = true,
                        code = "mutation_configuration_changed",
                        message = "Seerr configuration changed while preparing the request. No mutation was attempted; retry with fresh data."
                    })
                    { StatusCode = 409 };
                }

                config = currentMutationConfig;
                configuredUrls = GetConfiguredUrls(config.SeerrUrls);
                if (!freshResolution.IsFound || freshResolution.User == null)
                {
                    if (freshResolution.Status is SeerrUserResolutionStatus.NotFound
                        or SeerrUserResolutionStatus.Blocked)
                    {
                        InvalidateUserIdentityCache(jellyfinUserId);
                    }

                    return new ObjectResult(new
                    {
                        error = true,
                        code = freshResolution.Status == SeerrUserResolutionStatus.Blocked
                            ? "blocked"
                            : "mutation_identity_unavailable",
                        message = "The current Seerr identity could not be revalidated. No mutation was attempted."
                    })
                    {
                        StatusCode = freshResolution.Status switch
                        {
                            SeerrUserResolutionStatus.Blocked => 403,
                            SeerrUserResolutionStatus.Unavailable => 503,
                            SeerrUserResolutionStatus.Incomplete => 502,
                            _ => 409,
                        }
                    };
                }

                var freshUser = freshResolution.User;
                var freshSource = FindConfiguredSource(configuredUrls, freshUser.SourceUrl);
                if (freshUser.Id != seerrUser!.Id
                    || freshUser.Permissions != seerrUser.Permissions
                    || freshSource == null
                    || !string.Equals(freshSource, boundSourceUrl, StringComparison.Ordinal))
                {
                    InvalidateUserIdentityCache(jellyfinUserId);
                    return new ObjectResult(new
                    {
                        error = true,
                        code = "mutation_identity_changed",
                        message = "The linked Seerr identity changed while preparing the request. No mutation was attempted; retry with fresh data."
                    })
                    { StatusCode = 409 };
                }

                seerrUser = freshUser;
                seerrUserId = freshUser.Id.ToString(System.Globalization.CultureInfo.InvariantCulture);
                urls = new[] { boundSourceUrl! };
            }

            var httpClient = SeerrHttpHelper.CreateClient(_httpClientFactory);
            httpClient.Timeout = TimeSpan.FromSeconds(15);

            int lastStatusCode = 502;
            object lastErrorBody = new { error = true, code = "unreachable", message = "Can't reach Seerr right now. Please try again in a moment." };

            foreach (var url in urls)
            {
                cancellationToken.ThrowIfCancellationRequested();

                // Public reads may fail over across several configured Seerr
                // instances. Every iteration is a separate authorization point:
                // a completed failed request must not authorize another send
                // after the master switch or any configuration field changed.
                if (!integration.IsCurrent(_configProvider))
                {
                    var code = method == HttpMethod.Get
                        ? "read_configuration_changed"
                        : "mutation_configuration_changed";
                    var message = method == HttpMethod.Get
                        ? "Seerr configuration changed before the next request. Please try again."
                        : "Seerr configuration changed before dispatch. No mutation was attempted; retry with fresh data.";
                    return new ObjectResult(new
                    {
                        error = true,
                        code,
                        message,
                    })
                    { StatusCode = 409 };
                }

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
                    // Public-scope fetches (genres/person/keyword) are stored under the
                    // shared `public:` cache key, so their bodies MUST stay user-neutral.
                    // Omit X-Api-User on those requests — exactly as the certification
                    // cache already does — so an upstream can never scope the response to
                    // this caller and leak one user's view into every user's cache. The
                    // invariant: a body cached under a shared key never carries a per-user
                    // header on the fetch that produced it.
                    var requestUserId = isPublicScope ? null : seerrUserId;
                    using var request = SeerrHttpHelper.BuildRequest(method, requestUri, config.SeerrApiKey, requestUserId, content);
                    if (content != null) _logger.LogDebug($"Request body: {content}");

                    var (json, error, _) = await SeerrHttpHelper.SendAndReadJsonAsync(
                        httpClient,
                        request,
                        requestUri,
                        requestDispatchFence,
                        cancellationToken).ConfigureAwait(false);

                    if (error == null && json != null)
                    {
                        if (method == HttpMethod.Get
                            && !requestConfigStamp.Matches(
                                _configProvider.ConfigurationOrNull,
                                _configProvider.ConfigurationRevision))
                        {
                            return new ObjectResult(new
                            {
                                error = true,
                                code = "read_configuration_changed",
                                message = "Seerr configuration changed while the response was in flight. Please try again."
                            })
                            { StatusCode = 409 };
                        }

                        // Cache only complete, size-bounded, parsed JSON 2xx responses.
                        // SendAndReadJsonAsync also prevents HTML challenge pages from
                        // being cached as JSON for 10 min.
                        if (isCacheable)
                        {
                            var publishedEntry = (
                                Content: json,
                                CachedAt: DateTime.UtcNow,
                                ConfigurationRevision: requestConfigurationRevision,
                                ConfigurationIdentity: requestConfigurationIdentity);
                            if (!TryPublishResponseCacheEntry(
                                    _seerrCache.ResponseCache,
                                    _seerrCache.ResponseCacheLock,
                                    cacheKey,
                                    publishedEntry,
                                    requestDispatchFence))
                            {
                                return new ObjectResult(new
                                {
                                    error = true,
                                    code = "read_configuration_changed",
                                    message = "Seerr configuration changed while caching the response. Please try again."
                                })
                                { StatusCode = 409 };
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
                        var filtered = await ApplyParentalFilterAsync(json, apiPath, caller).ConfigureAwait(false);
                        cancellationToken.ThrowIfCancellationRequested();
                        if (method == HttpMethod.Get
                            && !requestConfigStamp.Matches(
                                _configProvider.ConfigurationOrNull,
                                _configProvider.ConfigurationRevision))
                        {
                            return new ObjectResult(new
                            {
                                error = true,
                                code = "read_configuration_changed",
                                message = "Seerr configuration changed while filtering the response. Please try again."
                            })
                            { StatusCode = 409 };
                        }

                        return filtered;
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
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
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

        public void InvalidateUserIdentityCache(string jellyfinUserId)
        {
            var cacheKey = NormalizeUserId(jellyfinUserId);
            lock (_seerrCache.UserCacheLock)
            {
                _seerrCache.UserCache.Remove(cacheKey);
            }

            lock (_seerrCache.UserIdCacheLock)
            {
                _seerrCache.UserIdCache.Remove(cacheKey);
            }
        }

        private async Task<SeerrUser?> FetchExactUserBindingAsync(
            string jellyfinUserId,
            int seerrUserId,
            string sourceUrl,
            string apiKey,
            SeerrDispatchFence dispatchFence,
            CancellationToken cancellationToken)
        {
            if (seerrUserId <= 0) return null;
            var expectedJellyfinUserId = SeerrPaginationHelper.CanonicalJellyfinUserIdentity(
                jellyfinUserId);
            if (expectedJellyfinUserId == null) return null;

            var requestUri = $"{sourceUrl}/api/v1/user/{seerrUserId}";
            try
            {
                if (!dispatchFence.CanDispatch()) return null;
                var httpClient = SeerrHttpHelper.CreateClient(_httpClientFactory);
                httpClient.Timeout = TimeSpan.FromSeconds(15);
                using var request = SeerrHttpHelper.BuildRequest(
                    HttpMethod.Get,
                    requestUri,
                    apiKey);
                var (json, error, _) = await SeerrHttpHelper.SendAndReadJsonAsync(
                    httpClient,
                    request,
                    requestUri,
                    dispatchFence,
                    cancellationToken).ConfigureAwait(false);
                if (error != null || json == null) return null;

                var user = JsonSerializer.Deserialize<SeerrUser>(json);
                var actualJellyfinUserId = SeerrPaginationHelper.CanonicalJellyfinUserIdentity(
                    user?.JellyfinUserId);
                if (user == null
                    || user.Id != seerrUserId
                    || !string.Equals(
                        actualJellyfinUserId,
                        expectedJellyfinUserId,
                        StringComparison.OrdinalIgnoreCase))
                {
                    return null;
                }

                user.JellyfinUserId = actualJellyfinUserId;
                user.SourceUrl = sourceUrl;
                return user;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    "Exact Seerr user-binding validation failed at {Source}: {Type}: {Message}",
                    sourceUrl,
                    ex.GetType().Name,
                    ex.Message);
                return null;
            }
        }

        // ── Watchlist / requests helpers ─────────────────────────────────────

        public Task<List<WatchlistItem>?> GetWatchlistForUser(string seerrUserId)
        {
            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            var configuredUrls = integration.Urls;
            // The legacy overload carries an instance-local user id without its
            // identity domain. It is safe only when configuration proves there
            // is exactly one possible source.
            return integration.IsActive && configuredUrls.Length == 1
                ? GetWatchlistForUser(seerrUserId, configuredUrls[0])
                : Task.FromResult<List<WatchlistItem>?>(null);
        }

        public async Task<List<WatchlistItem>?> GetWatchlistForUser(
            string seerrUserId,
            string? sourceUrl,
            CancellationToken cancellationToken = default)
        {
            try
            {
                var integration = SeerrIntegrationPolicy.Capture(_configProvider);
                if (!integration.IsActive)
                {
                    return null;
                }

                var configuredSource = FindConfiguredSource(
                    integration.Urls,
                    sourceUrl);
                if (configuredSource == null)
                {
                    _logger.LogWarning(
                        "Refusing a Seerr watchlist lookup because the instance-local user id had no current source binding.");
                    return null;
                }

                var urls = new[] { configuredSource };
                var httpClient = SeerrHttpHelper.CreateClient(_httpClientFactory);
                SeerrDispatchFence dispatchFence = integration.CreateDispatchFence(_configProvider);
                var snapshot = await SeerrPaginationHelper.FetchAllAsync(
                    httpClient,
                    urls,
                    (url, page, _) => $"{url}/api/v1/user/{seerrUserId}/watchlist?take=100&page={page}",
                    integration.ApiKey,
                    seerrUserId,
                    requestedPageSize: 100,
                    WatchlistCollectionIdentity,
                    dispatchFence,
                    cancellationToken).ConfigureAwait(false);

                if (!snapshot.IsComplete)
                {
                    LogIncompleteCollection("watchlist", snapshot);
                    return null;
                }

                if (!integration.IsCurrent(_configProvider))
                {
                    return null;
                }

                var items = new List<WatchlistItem>(snapshot.Items.Count);
                foreach (var item in snapshot.Items)
                {
                    if (!item.TryGetProperty("tmdbId", out var tmdbId)
                        || tmdbId.ValueKind != JsonValueKind.Number
                        || !tmdbId.TryGetInt32(out var parsedTmdbId)
                        || parsedTmdbId <= 0
                        || !item.TryGetProperty("mediaType", out var mediaType)
                        || !TryNormalizeMediaType(mediaType, out var normalizedMediaType))
                    {
                        _logger.LogWarning(
                            "A complete Seerr watchlist from {Url} contained an invalid row; refusing a partial result.",
                            snapshot.SourceUrl);
                        return null;
                    }

                    items.Add(new WatchlistItem
                    {
                        TmdbId = parsedTmdbId,
                        MediaType = normalizedMediaType,
                    });
                }

                return integration.IsCurrent(_configProvider) ? items : null;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogError($"Error getting Seerr watchlist: {ex}");
            }

            return null;
        }

        public Task<List<WatchlistItem>?> GetRequestsForUser(string seerrUserId)
        {
            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            var config = integration.Configuration;
            var configuredUrls = integration.Urls;
            return integration.IsActive && config != null && configuredUrls.Length == 1
                ? GetRequestsForUser(
                    seerrUserId,
                    configuredUrls[0],
                    config,
                    integration.ConfigurationRevision,
                    integration.ApiKey,
                    configuredUrls)
                : Task.FromResult<List<WatchlistItem>?>(null);
        }

        public Task<List<WatchlistItem>?> GetRequestsForUser(
            string seerrUserId,
            string? sourceUrl,
            CancellationToken cancellationToken = default)
        {
            var integration = SeerrIntegrationPolicy.Capture(_configProvider);
            var config = integration.Configuration;
            return !integration.IsActive || config == null
                ? Task.FromResult<List<WatchlistItem>?>(null)
                : GetRequestsForUser(
                    seerrUserId,
                    sourceUrl,
                    config,
                    integration.ConfigurationRevision,
                    integration.ApiKey,
                    integration.Urls,
                    cancellationToken);
        }

        public async Task<List<WatchlistItem>?> GetRequestsForUser(
            string seerrUserId,
            string? sourceUrl,
            PluginConfiguration capturedConfiguration,
            long configurationRevision,
            string capturedApiKey,
            IReadOnlyList<string> capturedConfiguredUrls,
            CancellationToken cancellationToken = default)
        {
            try
            {
                var configStamp = SeerrMutationConfigStamp.Capture(
                    capturedConfiguration,
                    configurationRevision);
                var integration = SeerrIntegrationPolicy.Capture(_configProvider);
                SeerrDispatchFence dispatchFence = integration
                    .CreateDispatchFence(_configProvider)
                    .Restrict(() => configStamp.Matches(
                        _configProvider.ConfigurationOrNull,
                        _configProvider.ConfigurationRevision));
                var configuredUrls = capturedConfiguredUrls.ToArray();
                var apiKey = capturedApiKey;
                if (!SeerrIntegrationPolicy.HasUsableSavedConfiguration(capturedConfiguration)
                    || configuredUrls.Length == 0
                    || string.IsNullOrEmpty(apiKey)
                    || !SeerrIntegrationPolicy.HasUsableSavedConfiguration(
                        _configProvider.ConfigurationOrNull)
                    || !configStamp.Matches(
                        _configProvider.ConfigurationOrNull,
                        _configProvider.ConfigurationRevision))
                {
                    return null;
                }

                var configuredSource = FindConfiguredSource(
                    configuredUrls,
                    sourceUrl);
                if (configuredSource == null)
                {
                    _logger.LogWarning(
                        "Refusing a Seerr request lookup because the instance-local user id had no current source binding.");
                    return null;
                }

                var urls = new[] { configuredSource };
                var httpClient = SeerrHttpHelper.CreateClient(_httpClientFactory);
                var snapshot = await SeerrPaginationHelper.FetchAllAsync(
                    httpClient,
                    urls,
                    (url, _, skip) => $"{url}/api/v1/request?take=500&skip={skip}&sort=added&requestedBy={Uri.EscapeDataString(seerrUserId)}",
                    apiKey,
                    seerrUserId,
                    requestedPageSize: 500,
                    RequestCollectionIdentity,
                    dispatchFence,
                    cancellationToken).ConfigureAwait(false);

                if (!SeerrIntegrationPolicy.HasUsableSavedConfiguration(
                        _configProvider.ConfigurationOrNull)
                    || !configStamp.Matches(
                        _configProvider.ConfigurationOrNull,
                        _configProvider.ConfigurationRevision))
                {
                    return null;
                }

                if (!snapshot.IsComplete)
                {
                    LogIncompleteCollection("request", snapshot);
                    return null;
                }

                var items = new List<WatchlistItem>();
                foreach (var item in snapshot.Items)
                {
                    if (!TryGetRequestOwnerId(item, out var ownerId))
                    {
                        _logger.LogWarning(
                            "A complete Seerr request collection from {Url} contained a row with invalid ownership; refusing a partial result.",
                            snapshot.SourceUrl);
                        return null;
                    }

                    if (!string.Equals(ownerId, seerrUserId, StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    var parsed = ParseRequestItem(item);
                    if (parsed == null)
                    {
                        _logger.LogWarning(
                            "A complete Seerr request collection from {Url} contained an invalid row for user {UserId}; refusing a partial result.",
                            snapshot.SourceUrl,
                            seerrUserId);
                        return null;
                    }

                    items.Add(parsed);
                }

                return SeerrIntegrationPolicy.HasUsableSavedConfiguration(
                        _configProvider.ConfigurationOrNull)
                    && configStamp.Matches(
                        _configProvider.ConfigurationOrNull,
                        _configProvider.ConfigurationRevision)
                    ? items
                    : null;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogError($"Error getting Seerr requests: {ex}");
            }

            return null;
        }

        private void LogIncompleteCollection(string collectionName, SeerrPagedCollectionResult snapshot)
        {
            if (snapshot.Error != null)
            {
                var error = snapshot.Error;
                _logger.LogWarning(
                    "Failed to fetch a complete Seerr {Collection} collection from {Url}: code={Code} status={Status} cf-ray={CfRay} — {Message}; {Reason}",
                    collectionName,
                    snapshot.SourceUrl,
                    error.Code,
                    error.HttpStatus,
                    error.CfRay,
                    error.Message,
                    snapshot.FailureReason);
                return;
            }

            _logger.LogWarning(
                "Failed to fetch a complete Seerr {Collection} collection from configured URLs: {Reason}",
                collectionName,
                snapshot.FailureReason);
        }

        private static string? UserCollectionIdentity(JsonElement item)
            => SeerrPaginationHelper.CanonicalPositiveIntegerPropertyIdentity(item, "id");

        private static string? WatchlistCollectionIdentity(JsonElement item)
        {
            var tmdbId = SeerrPaginationHelper.CanonicalPositiveIntegerPropertyIdentity(item, "tmdbId");
            var mediaType = item.TryGetProperty("mediaType", out var mediaTypeValue)
                && mediaTypeValue.ValueKind == JsonValueKind.String
                    ? mediaTypeValue.GetString()?.Trim().ToLowerInvariant()
                    : null;
            return tmdbId == null || mediaType == null
                ? null
                : $"{mediaType}:{tmdbId}";
        }

        private static string? RequestCollectionIdentity(JsonElement item)
            => SeerrPaginationHelper.CanonicalPositiveIntegerPropertyIdentity(item, "id");

        private static bool TryGetRequestOwnerId(JsonElement requestElement, out string? ownerId)
        {
            ownerId = null;
            if (!requestElement.TryGetProperty("requestedBy", out var requestedBy))
            {
                return false;
            }

            var ownerValue = requestedBy.ValueKind == JsonValueKind.Object
                && requestedBy.TryGetProperty("id", out var nestedId)
                    ? nestedId
                    : requestedBy;
            ownerId = SeerrPaginationHelper.CanonicalPositiveIntegerIdentity(ownerValue);
            return ownerId != null;
        }

        private static WatchlistItem? ParseRequestItem(JsonElement requestElement)
        {
            int tmdbId = 0;
            int? tvdbId = null;
            string? mediaType = null;

            if (requestElement.TryGetProperty("media", out var media))
            {
                if (media.ValueKind != JsonValueKind.Object) return null;
                if (!TryMergePositiveIntegerProperty(media, "tmdbId", ref tmdbId)) return null;

                // Seerr media objects carry tvdbId for TV — expose it (0/absent → null) so the
                // download-queue filter can match a Sonarr record that reports tmdbId 0.
                if (media.TryGetProperty("tvdbId", out var tvdbProp) && tvdbProp.ValueKind == JsonValueKind.Number)
                {
                    tvdbId = ArrIdHelper.ToNullableId(tvdbProp.GetInt32());
                }

                if (!TryMergeMediaType(media, "mediaType", ref mediaType))
                {
                    return null;
                }
            }

            if (!TryMergePositiveIntegerProperty(requestElement, "tmdbId", ref tmdbId)) return null;

            if (!TryMergeMediaType(requestElement, "mediaType", ref mediaType)
                || !TryMergeMediaType(requestElement, "type", ref mediaType))
            {
                return null;
            }

            if (tmdbId == 0 || mediaType == null)
            {
                return null;
            }

            return new WatchlistItem
            {
                TmdbId = tmdbId,
                MediaType = mediaType,
                TvdbId = tvdbId
            };
        }

        private static bool TryMergePositiveIntegerProperty(
            JsonElement owner,
            string propertyName,
            ref int mergedValue)
        {
            if (!owner.TryGetProperty(propertyName, out var value)) return true;
            var canonical = SeerrPaginationHelper.CanonicalPositiveIntegerIdentity(value);
            if (canonical == null
                || !int.TryParse(
                    canonical,
                    System.Globalization.NumberStyles.None,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out var parsed))
            {
                return false;
            }

            if (mergedValue > 0 && mergedValue != parsed) return false;
            mergedValue = parsed;
            return true;
        }

        private static bool TryNormalizeMediaType(JsonElement value, out string normalized)
        {
            normalized = string.Empty;
            if (value.ValueKind != JsonValueKind.String) return false;
            normalized = value.GetString()?.Trim().ToLowerInvariant() ?? string.Empty;
            return normalized is "movie" or "tv";
        }

        private static bool TryMergeMediaType(
            JsonElement owner,
            string propertyName,
            ref string? mediaType)
        {
            if (!owner.TryGetProperty(propertyName, out var value)) return true;
            if (!TryNormalizeMediaType(value, out var candidate)) return false;
            if (mediaType != null && !string.Equals(mediaType, candidate, StringComparison.Ordinal)) return false;
            mediaType = candidate;
            return true;
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
        private static readonly TimeSpan _pollLogInterval = TimeSpan.FromMinutes(5);
        private static readonly Helpers.BoundedTtlCache<string, (string LastMsg, int Count, DateTime LastLogged)>
            _pollLogDedup = new(
                maximumEntries: 4_096,
                maximumWeight: 4L * 1024 * 1024,
                weight: static (key, entry) => key.Length + entry.LastMsg.Length + 16,
                comparer: StringComparer.Ordinal,
                defaultTtl: static () => TimeSpan.FromMinutes(30));

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
