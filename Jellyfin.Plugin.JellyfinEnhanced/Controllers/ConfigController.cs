using Microsoft.AspNetCore.Mvc;
using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Security.Cryptography;
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
using Newtonsoft.Json.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model;
using MediaBrowser.Controller.Persistence;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Enums;
using Microsoft.EntityFrameworkCore;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// Plugin config and asset endpoints (public/private config, script/css/version/locales serving).
    /// Split out of the former JellyfinEnhancedController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class ConfigController : JellyfinEnhancedControllerBase
    {
        public ConfigController(
            IHttpClientFactory httpClientFactory,
            ILogger<ConfigController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
        }

        [HttpGet("script")]
        public ActionResult GetMainScript() => GetScriptResource("js/plugin.js");
        [HttpGet("js/{**path}")]
        public ActionResult GetScript(string path) => GetScriptResource($"js/{path}");
        // Config-page stylesheet lives in Configuration/ next to configPage.html.
        [HttpGet("Configuration/configPage.css")]
        public ActionResult GetConfigPageStylesheet() => GetScriptResource("Configuration/configPage.css");
        // [AllowAnonymous]: version is loaded by translations.js cache-buster pre-login.
        // Information disclosure of the plugin version is acceptable — Jellyfin core
        // exposes its own version pre-auth too. CVEs against JE are tracked publicly
        // so attackers do not need this endpoint to fingerprint a vulnerable version.
        [HttpGet("version")]
        public ActionResult GetVersion() => Content(JellyfinEnhanced.Instance?.Version.ToString() ?? "unknown");

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

            return new JsonResult(new
            {
                // For Arr Links (legacy single-instance fields, kept for backward compat)
                config.SonarrUrl,
                config.RadarrUrl,
                config.BazarrUrl,
                config.SonarrUrlMappings,
                config.RadarrUrlMappings,
                config.BazarrUrlMappings,

                // Multi-instance Sonarr/Radarr (no API keys exposed). Enabled flag is exposed so
                // the config page can render a per-instance toggle and arr-links can filter
                // disabled instances from the dropdown without a round-trip.
                SonarrInstances = config.GetSonarrInstances().Select(i => new { i.Name, i.Url, i.UrlMappings, i.Enabled }),
                RadarrInstances = config.GetRadarrInstances().Select(i => new { i.Name, i.Url, i.UrlMappings, i.Enabled }),

                // Corruption flags so the frontend can surface a toast without waiting for an
                // action endpoint to round-trip a corruption error envelope.
                SonarrInstancesCorrupt = config.IsSonarrInstancesCorrupt(),
                RadarrInstancesCorrupt = config.IsRadarrInstancesCorrupt(),
            });
        }
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

            // Expose whether TMDB is configured as a boolean so all users
            // (including non-admin) can use TMDB-dependent features like
            // Reviews and Elsewhere without leaking the actual API key.
            var tmdbEnabled = !string.IsNullOrWhiteSpace(config.TMDB_API_KEY);

            // Only authenticated callers see internal Seerr URLs — they're used by
            // client-side deep links and would otherwise leak network topology to
            // unauthenticated visitors hitting the login page.
            bool isAuthed = User?.Identity?.IsAuthenticated == true;

            string jellyseerrBaseUrl = string.Empty;
            string jellyseerrUrlMappings = string.Empty;
            if (isAuthed)
            {
                try
                {
                    if (!string.IsNullOrWhiteSpace(config.JellyseerrUrls))
                    {
                        jellyseerrBaseUrl = config.JellyseerrUrls
                            .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                            .Select(u => u.Trim())
                            .FirstOrDefault() ?? string.Empty;
                    }
                }
                catch { /* ignore */ }
                jellyseerrUrlMappings = config.JellyseerrUrlMappings ?? string.Empty;
            }

            return new JsonResult(new
            {
                // Jellyfin Enhanced Settings
                TmdbEnabled = tmdbEnabled,
                config.ToastDuration,
                config.HelpPanelAutocloseDelay,
                config.EnableCustomSplashScreen,
                config.SplashScreenImageUrl,

                // Jellyfin Elsewhere Settings
                config.ElsewhereEnabled,
                config.DEFAULT_REGION,
                config.DEFAULT_PROVIDERS,
                config.IGNORE_PROVIDERS,
                config.ElsewhereCustomBrandingText,
                config.ElsewhereCustomBrandingImageUrl,
                config.ClearLocalStorageTimestamp,
                config.ClearTranslationCacheTimestamp,

                // Default User Settings
                config.AutoPauseEnabled,
                config.AutoResumeEnabled,
                config.AutoPipEnabled,
                config.AutoSkipIntro,
                config.AutoSkipOutro,
                config.LongPress2xEnabled,
                config.RandomButtonEnabled,
                config.RandomIncludeMovies,
                config.RandomIncludeShows,
                config.RandomUnwatchedOnly,
                config.ShowWatchProgress,
                config.ShowFileSizes,
                config.RemoveContinueWatchingEnabled,
                config.ShowAudioLanguages,
                config.Shortcuts,
                config.ShowReviews,
                config.ShowUserReviews,
                config.ReviewsExpandedByDefault,
                config.HideReviewsFromHiddenUsers,
                config.HideReviewsFromDisabledUsers,
                config.ShowReleaseDates,
                config.ShowUserRatingOnPosters,
                config.ShowUserRatingDash,
                config.PauseScreenEnabled,
                config.QualityTagsEnabled,
                config.ShowResolutionTag,
                config.ShowSourceTag,
                config.ShowDynamicRangeTag,
                config.ShowSpecialFormatTag,
                config.ShowVideoCodecTag,
                config.ShowAudioInfoTag,
                config.ResolutionTagOrder,
                config.SourceTagOrder,
                config.DynamicRangeTagOrder,
                config.SpecialFormatTagOrder,
                config.VideoCodecTagOrder,
                config.AudioInfoTagOrder,
                config.GenreTagsEnabled,
                config.LanguageTagsEnabled,
                config.RatingTagsEnabled,
                config.PeopleTagsEnabled,
                config.DisableAllShortcuts,
                config.DefaultSubtitleStyle,
                config.DefaultSubtitleSize,
                config.DefaultSubtitleFont,
                config.DisableCustomSubtitleStyles,
                config.DefaultLanguage,
                // Overlay positions
                config.QualityTagsPosition,
                config.GenreTagsPosition,
                config.LanguageTagsPosition,
                config.RatingTagsPosition,
                config.ShowRatingInPlayer,

                config.TagsCacheTtlDays,
                config.DisableTagsOnSearchPage,
                config.TagsHideOnHover,
                config.TagCacheServerMode,
                config.EnableTagsLocalStorageFallback,

                // Seerr Search Settings
                config.JellyseerrEnabled,
                config.JellyseerrShowSearchResults,
                config.JellyseerrShowReportButton,
                config.JellyseerrShowIssueIndicator,
                config.JellyseerrEnable4KRequests,
                config.JellyseerrEnable4KTvRequests,
                config.ShowCollectionsInSearch,
                config.JellyseerrShowAdvanced,
                config.JellyseerrShowQuotaInfo,
                config.ShowElsewhereOnJellyseerr,
                config.JellyseerrUseMoreInfoModal,
                config.AddRequestedMediaToWatchlist,
                config.SyncJellyseerrWatchlist,
                config.JellyseerrAutoImportUsers,
                config.JellyseerrShowSimilar,
                config.JellyseerrShowRecommended,
                config.JellyseerrShowRequestMoreOnSeries,
                config.JellyseerrShowNetworkDiscovery,
                config.JellyseerrShowGenreDiscovery,
                config.JellyseerrShowTagDiscovery,
                config.JellyseerrShowPersonDiscovery,
                config.JellyseerrExcludeLibraryItems,
                config.JellyseerrExcludeBlocklistedItems,
                config.JellyseerrDisableCache,
                JellyseerrBaseUrl = jellyseerrBaseUrl,
                JellyseerrUrlMappings = jellyseerrUrlMappings,

                // Bookmarks Settings
                config.BookmarksEnabled,
                config.BookmarksUsePluginPages,
                config.BookmarksUseCustomTabs,
                config.BookmarksUseNativeTab,

                // Arr Links Settings
                config.ArrLinksEnabled,
                config.ShowArrLinksAsText,
                config.ArrLinksShowStatusSingle,

                // Arr Tags Sync Settings
                config.ArrTagsSyncEnabled,
                config.ArrTagsPrefix,
                config.ArrTagsShowAsLinks,
                config.ArrTagsLinksFilter,
                config.ArrTagsLinksHideFilter,

                // Letterboxd Settings
                config.LetterboxdEnabled,
                config.ShowLetterboxdLinkAsText,
                // Metadata Icons (Druidblack)
                config.MetadataIconsEnabled,

                // Icon Settings
                config.UseIcons,
                config.IconStyle,

                // Extras Settings
                config.ColoredRatingsEnabled,
                config.ThemeSelectorEnabled,
                config.ColoredActivityIconsEnabled,
                config.PluginIconsEnabled,
                config.EnableLoginImage,
                config.ActiveStreamsEnabled,
                config.ActiveStreamsAllUsers,

                // Requests Page Settings
                config.DownloadsPageEnabled,
                config.DownloadsPageShowIssues,
                config.ShowDownloadsInRequests,
                config.DownloadsUsePluginPages,
                config.DownloadsUseCustomTabs,
                config.DownloadsUseNativeTab,
                config.DownloadsPagePollingEnabled,
                config.DownloadsPollIntervalSeconds,
                config.DownloadsFilterByUserRequests,

                // Calendar Page Settings
                config.CalendarPageEnabled,
                config.CalendarUseCustomTabs,
                config.CalendarUsePluginPages,
                config.CalendarUseNativeTab,
                config.CalendarFirstDayOfWeek,
                config.CalendarTimeFormat,
                config.CalendarHighlightFavorites,
                config.CalendarHighlightWatchedSeries,
                config.CalendarFilterByLibraryAccess,
                config.CalendarShowOnlyRequested,
                config.CalendarForceOnlyRequested,

                // Hidden Content Settings
                config.HiddenContentEnabled,
                config.HiddenContentUsePluginPages,
                config.HiddenContentUseCustomTabs,
                config.HiddenContentUseNativeTab,
                config.HiddenContentAdmin,

                // Maintenance Mode
                config.MaintenanceModeEnabled,
                config.MaintenanceModeMessage,
                config.MaintenanceModeAction,
                config.MaintenanceModeAffectedUsers,

            });
        }

        [HttpGet("locales")]
        [Authorize]
        [ResponseCache(Duration = 86400)]
        public ActionResult GetAvailableLocales()
        {
            var prefix = "Jellyfin.Plugin.JellyfinEnhanced.js.locales.";
            var suffix = ".json";
            var locales = Assembly.GetExecutingAssembly()
                .GetManifestResourceNames()
                .Where(n => n.StartsWith(prefix, StringComparison.Ordinal) && n.EndsWith(suffix, StringComparison.Ordinal))
                .Select(n => n.Substring(prefix.Length, n.Length - prefix.Length - suffix.Length))
                .Where(code => code != "en") // Exclude base English (en-GB and en-US are the usable variants)
                .OrderBy(code => code, StringComparer.OrdinalIgnoreCase)
                .ToArray();

            return Ok(locales);
        }

        [HttpGet("locales/{lang}.json")]
        public ActionResult GetLocale(string lang)
        {
            var sanitizedLang = Path.GetFileName(lang); // Basic sanitization
            var resourcePath = $"Jellyfin.Plugin.JellyfinEnhanced.js.locales.{sanitizedLang}.json";
            var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourcePath);

            if (stream == null && sanitizedLang.Contains('-'))
            {
                // Fall back from regional variant (e.g. de-DE) to the base language (de).
                // Jellyfin reports BCP-47 codes like de-DE when the user picks "Auto" or a
                // regional locale, but the plugin only ships base-language files for most
                // languages. Without this fallback the user gets English instead of German.
                var baseLang = sanitizedLang.Split('-')[0];
                var fallbackPath = $"Jellyfin.Plugin.JellyfinEnhanced.js.locales.{baseLang}.json";
                stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(fallbackPath);
                if (stream != null)
                {
                    _logger.LogInformation($"Locale file not found for {sanitizedLang}, falling back to base language {baseLang}");
                }
            }

            if (stream == null)
            {
                _logger.LogWarning($"Locale file not found for language: {sanitizedLang}");
                return NotFound();
            }

            return new FileStreamResult(stream, "application/json");
        }

        private ActionResult GetScriptResource(string resourcePath)
        {
            var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream($"Jellyfin.Plugin.JellyfinEnhanced.{resourcePath.Replace('/', '.')}");
            if (stream == null) return NotFound();

            // Pick a content type that matches the requested file. Defaults to JS for the
            // legacy /js/* callers; adds CSS so /css/* doesn't get served as application/javascript
            // (which breaks <link rel="stylesheet"> in strict-MIME browsers).
            string contentType = "application/javascript";
            if (resourcePath.EndsWith(".css", StringComparison.OrdinalIgnoreCase))
                contentType = "text/css";
            else if (resourcePath.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
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
    }
}
