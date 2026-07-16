using Microsoft.AspNetCore.Mvc;
using System;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Linq;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.StaticFiles;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using MediaBrowser.Controller;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model;
using MediaBrowser.Controller.Persistence;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Enums;
using Microsoft.EntityFrameworkCore;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    /// <summary>
    /// Plugin config and asset endpoints (public/private config, script/css/version/locales serving).
    /// Split out of the former JellyfinCanopyController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinCanopy")]
    [ApiController]
    public class ConfigController : JellyfinCanopyControllerBase
    {
        private const string ImmutableLocaleCacheControl =
            "public, max-age=86400, immutable";
        private const string MissingLocaleCacheControl =
            "public, max-age=300";
        private const string ImmutableClientCacheControl =
            "public, max-age=31536000, immutable";
        private const string RevalidateClientCacheControl =
            "public, max-age=0, must-revalidate";
        private const string MissingClientCacheControl =
            "no-store";

        private static readonly LocaleResourceCatalog LocaleCatalog =
            LocaleResourceCatalog.Load(Assembly.GetExecutingAssembly());
        private static readonly LocaleMissLogLimiter SharedLocaleMissLogLimiter =
            new();
        private static readonly Lazy<ClientDistResourceCatalog> SharedClientCatalog =
            new(() => ClientDistResourceCatalog.Load(Assembly.GetExecutingAssembly()));

        private readonly ILiveSessionRegistry _liveSessionRegistry;
        private readonly LocaleMissLogLimiter _localeMissLogLimiter;
        private readonly ClientDistResourceCatalog? _clientCatalog;

        public ConfigController(
            IHttpClientFactory httpClientFactory,
            ILogger<ConfigController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            ILiveSessionRegistry liveSessionRegistry)
            : this(
                httpClientFactory,
                logger,
                userManager,
                seerrCache,
                configProvider,
                liveSessionRegistry,
                SharedLocaleMissLogLimiter,
                SharedClientCatalog.Value)
        {
        }

        internal ConfigController(
            IHttpClientFactory httpClientFactory,
            ILogger<ConfigController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            ILiveSessionRegistry liveSessionRegistry,
            LocaleMissLogLimiter localeMissLogLimiter)
            : this(
                httpClientFactory,
                logger,
                userManager,
                seerrCache,
                configProvider,
                liveSessionRegistry,
                localeMissLogLimiter,
                clientCatalog: null)
        {
        }

        internal ConfigController(
            IHttpClientFactory httpClientFactory,
            ILogger<ConfigController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            ILiveSessionRegistry liveSessionRegistry,
            LocaleMissLogLimiter localeMissLogLimiter,
            ClientDistResourceCatalog? clientCatalog)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _liveSessionRegistry = liveSessionRegistry;
            _localeMissLogLimiter = localeMissLogLimiter;
            _clientCatalog = clientCatalog;
        }

        [HttpGet("script")]
        public ActionResult GetMainScript() => GetScriptResource("js/plugin.js");
        [HttpGet("js/{**path}")]
        public ActionResult GetScript(string path) => GetScriptResource($"js/{path}");
        // Generated client assets are served only from the embedded schema-v2
        // manifest inventory. Bare paths retain the classic loader/bootstrap
        // contract; module entries and nested chunks may additionally use the
        // current build-id prefix plus a bounded retry attempt. This keeps
        // ApiClient.getUrl reverse-proxy handling unchanged while stale builds,
        // unknown files, and path traversal fail closed.
        [HttpGet("dist/{**path}")]
        public ActionResult GetBundleResource(string path)
        {
            var catalog = _clientCatalog ?? SharedClientCatalog.Value;
            var resolution = catalog.Resolve(path);
            if (resolution.Status != ClientDistResolutionStatus.Found
                || resolution.Resource == null
                || !IsValidClientAttempt(resolution.IsGenerationScoped))
            {
                Response.Headers["Cache-Control"] = MissingClientCacheControl;
                return NotFound();
            }

            var resource = resolution.Resource;
            var devMode = _configProvider.ConfigurationOrNull?.DevMode == true;
            var cacheControl = devMode
                ? "no-store"
                : resource.IsManifest
                    ? RevalidateClientCacheControl
                    : ImmutableClientCacheControl;
            Response.Headers["Cache-Control"] = cacheControl;
            Response.Headers["ETag"] = resource.ETag;

            if (Request.Headers.TryGetValue("If-None-Match", out var ifNoneMatch)
                && IfNoneMatchSatisfied(ifNoneMatch, resource.ETag))
            {
                return StatusCode(StatusCodes.Status304NotModified);
            }

            return File(resource.Content, resource.ContentType);
        }
        // Config-page stylesheet lives in Configuration/ next to configPage.html.
        [HttpGet("Configuration/configPage.css")]
        public ActionResult GetConfigPageStylesheet() => GetScriptResource("Configuration/configPage.css");
        // Config-page script, externalized from the former inline <script> in configPage.html.
        // Loaded by the small bootstrap that remains inline there (see that file for why).
        [HttpGet("Configuration/config-page.js")]
        public ActionResult GetConfigPageScript() => GetScriptResource("Configuration/config-page.js");
        // [AllowAnonymous]: version is loaded by translations.js cache-buster pre-login.
        // Information disclosure of the plugin version is acceptable — Jellyfin core
        // exposes its own version pre-auth too. CVEs against JC are tracked publicly
        // so attackers do not need this endpoint to fingerprint a vulnerable version.
        [HttpGet("version")]
        public ActionResult GetVersion()
        {
            // A JC session pings this every 15 min (live-update recheck), so it
            // doubles as the live-push registry heartbeat: a web session that was
            // already open across a server restart (and therefore never refetched
            // public-config) re-registers here within one recheck interval and
            // resumes receiving config-changed pushes. Native clients never call
            // JC endpoints, so this can only ever register JC sessions.
            TouchLiveSessionRegistry();
            return Content(JellyfinCanopy.Instance?.Version.ToString() ?? "unknown");
        }

        /// <summary>
        /// Record the calling session's device id as running the JC client (no-op
        /// for unauthenticated callers, who carry no device claim). Claim type is
        /// the server's InternalClaimTypes.DeviceId ("Jellyfin-DeviceId"). The
        /// registering user is stored so the notifier can refuse pushes to devices
        /// the user has no live session on (the claim is caller-supplied).
        /// </summary>
        private void TouchLiveSessionRegistry()
        {
            if (User?.Identity?.IsAuthenticated != true)
            {
                return;
            }

            var deviceId = User.FindFirst("Jellyfin-DeviceId")?.Value;
            if (!string.IsNullOrWhiteSpace(deviceId))
            {
                // NOTE: UserHelper reads the JF12 claim ("Jellyfin-UserId");
                // the base controller's GetCurrentUserId() probes legacy claim
                // types (NameIdentifier/sub/Sid) that JF12 does not set.
                _liveSessionRegistry.Touch(deviceId, UserHelper.GetCurrentUserId(User) ?? Guid.Empty);
            }
        }

        [HttpGet("private-config")]
        [Authorize]
        public ActionResult GetPrivateConfig()
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null)
            {
                return StatusCode(503);
            }

            // Non-admin users receive an empty config object rather than a 403 so that the
            // client-side plugin initialises without error but never sees sensitive fields.
            if (!IsAdminUser())
            {
                return new JsonResult(new { });
            }

            // Check + log corruption so admins who never hit one of the action endpoints
            // still see a server-side error entry on private-config load.
            WarnIfArrInstancesCorrupt(config);

            return new JsonResult(BuildPrivateConfigPayload(config));
        }

        /// <summary>
        /// Pure projection of <see cref="PluginConfiguration"/> to the private-config payload
        /// (admin-only), driven by the <see cref="SettingDescriptors"/> registry. The registry
        /// is a WHITELIST — a setting without a Private descriptor never reaches the client.
        /// The exact payload (key set AND values) is pinned by the golden snapshots in
        /// JellyfinCanopy.Tests/Snapshots.
        /// </summary>
        internal static object BuildPrivateConfigPayload(PluginConfiguration config)
            => SettingDescriptors.BuildPayload(
                SettingExposure.Private,
                new SettingContext(config, IsAuthenticated: true));

        // [AllowAnonymous]: public-config is loaded by `loadLoginImageEarly` before
        // the user logs in, so we cannot gate the whole endpoint on [Authorize].
        // Instead, sensitive Seerr fields (BaseUrl, UrlMappings) are REDACTED for
        // unauthenticated callers — they only need login-screen toggles like
        // EnableLoginImage. Authenticated callers (any Jellyfin user) get the full
        // payload so client-side "Open in Seerr" deep links still work.
        [HttpGet("public-config")]
        public ActionResult GetPublicConfig()
        {
            var config = _configProvider.ConfigurationOrNull;
            if (config == null)
            {
                return StatusCode(503);
            }

            // Only authenticated callers see internal Seerr URLs — they're used by
            // client-side deep links and would otherwise leak network topology to
            // unauthenticated visitors hitting the login page.
            bool isAuthed = User?.Identity?.IsAuthenticated == true;

            // Every JC client boot AND every config-changed hot-reload refetches
            // this endpoint authenticated — record the session's device id so
            // LiveNotifierService pushes reach ONLY devices that actually run JC
            // (never native clients). Anonymous login-image fetches carry no
            // device claim and are skipped. The version endpoint doubles as the
            // 15-min heartbeat for sessions that outlive a server restart.
            TouchLiveSessionRegistry();

            return new JsonResult(BuildPublicConfigPayload(config, isAuthed));
        }

        /// <summary>
        /// Pure projection of <see cref="PluginConfiguration"/> to the public-config payload,
        /// driven by the <see cref="SettingDescriptors"/> registry. The registry is a WHITELIST —
        /// a setting without a Public descriptor never reaches the client — and caller-dependent
        /// redaction (Seerr URLs hidden pre-login) lives in the descriptors' value accessors.
        /// The exact payload (key set AND values) is pinned by the golden snapshots in
        /// JellyfinCanopy.Tests/Snapshots.
        /// </summary>
        internal static object BuildPublicConfigPayload(PluginConfiguration config, bool isAuthed)
            => SettingDescriptors.BuildPayload(
                SettingExposure.Public,
                new SettingContext(config, isAuthed));

        [HttpGet("locales")]
        [Authorize]
        [ResponseCache(Duration = 86400)]
        public ActionResult GetAvailableLocales()
        {
            Response.Headers["Cache-Control"] = ImmutableLocaleCacheControl;
            return Ok(SupportedLocaleCodes);
        }

        [HttpGet("locales/{lang}.json")]
        public ActionResult GetLocale(string lang)
        {
            var resolution = LocaleCatalog.Resolve(lang);
            if (resolution.Status is LocaleResolutionStatus.Invalid
                or LocaleResolutionStatus.Unsupported)
            {
                Response.Headers.Remove("Content-Language");
                Response.Headers["Cache-Control"] = MissingLocaleCacheControl;
                if (resolution.Status == LocaleResolutionStatus.Unsupported
                    && _logger.IsEnabled(LogLevel.Warning)
                    && _localeMissLogLimiter.ShouldLog(
                        resolution.NormalizedCode,
                        StatusCodes.Status404NotFound))
                {
                    _logger.LogWarning(
                        "Unsupported locale {LocaleCode} returned HTTP 404; repeated locale-miss logs are bounded",
                        resolution.NormalizedCode);
                }

                return NotFound();
            }

            var resource = resolution.Resource
                ?? throw new InvalidOperationException(
                    "Resolved locale has no cached resource");

            // Regional fallback is an ordinary BCP-47 compatibility path. It
            // is intentionally silent: the selected base locale is conveyed by
            // Content-Language without producing synchronous log work.
            Response.Headers["Cache-Control"] = ImmutableLocaleCacheControl;
            Response.Headers["Content-Language"] = resource.Code;
            return File(resource.Content, "application/json; charset=utf-8");
        }

        internal static IReadOnlyList<string> SupportedLocaleCodes =>
            LocaleCatalog.SupportedCodes;

        private ActionResult GetScriptResource(string resourcePath)
        {
            var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream($"Jellyfin.Plugin.JellyfinCanopy.{resourcePath.Replace('/', '.')}");
            if (stream == null) return NotFound();

            // Pick a content type that matches the requested file. Defaults to JS for the
            // legacy /js/* callers; adds CSS so /css/* doesn't get served as application/javascript
            // (which breaks <link rel="stylesheet"> in strict-MIME browsers).
            string contentType = "application/javascript";
            if (resourcePath.EndsWith(".css", StringComparison.OrdinalIgnoreCase))
                contentType = "text/css";
            else if (resourcePath.EndsWith(".json", StringComparison.OrdinalIgnoreCase) || resourcePath.EndsWith(".map", StringComparison.OrdinalIgnoreCase))
                contentType = "application/json";
            else if (resourcePath.EndsWith(".html", StringComparison.OrdinalIgnoreCase))
                contentType = "text/html";

            // DevMode: no-cache so the browser always re-fetches after a server restart,
            // useful when iterating on JS without bumping the version number.
            // Production: the script URL includes ?v={version}-{dllTimestamp}, so the URL
            // changes on every build and immutable caching is safe.
            var devMode = _configProvider.ConfigurationOrNull?.DevMode == true;
            Response.Headers["Cache-Control"] = devMode ? "no-store" : "public, max-age=31536000, immutable";
            return new FileStreamResult(stream, contentType);
        }

        private bool IsValidClientAttempt(bool generationScoped)
        {
            var query = Request.Query;
            if (!query.TryGetValue("attempt", out var values))
            {
                return !generationScoped || query.Count == 0;
            }

            if (!generationScoped
                || query.Count != 1
                || values.Count != 1)
            {
                return false;
            }

            var attempt = values[0];
            return attempt is "0" or "1" or "2";
        }

        private static bool IfNoneMatchSatisfied(
            Microsoft.Extensions.Primitives.StringValues header,
            string etag)
        {
            var bare = Unweaken(etag);
            foreach (var value in header)
            {
                if (string.IsNullOrEmpty(value))
                {
                    continue;
                }

                foreach (var candidate in value.Split(',').Select(static item => item.Trim()))
                {
                    if (candidate == "*"
                        || string.Equals(
                            Unweaken(candidate),
                            bare,
                            StringComparison.Ordinal))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        private static string Unweaken(string etag)
            => etag.StartsWith("W/", StringComparison.Ordinal)
                ? etag.Substring(2)
                : etag;
    }
}
