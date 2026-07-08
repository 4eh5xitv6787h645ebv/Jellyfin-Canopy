using System;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinElevate.Configuration
{
    /// <summary>Which client-facing config endpoint(s) a setting is projected to.</summary>
    internal enum SettingExposure
    {
        /// <summary>GET /JellyfinElevate/public-config (any caller, including pre-login).</summary>
        Public,

        /// <summary>GET /JellyfinElevate/private-config (admin users only).</summary>
        Private,

        /// <summary>Both endpoints. (No current setting uses this; kept so new settings can.)</summary>
        Both,

        /// <summary>
        /// Server-side only — never projected to a client config endpoint. Registered anyway so
        /// the PluginConfiguration ↔ UserSettings pairing is declared in exactly one place.
        /// </summary>
        Neither,
    }

    /// <summary>Inputs a setting value accessor may need beyond the configuration itself.</summary>
    internal readonly record struct SettingContext(PluginConfiguration Config, bool IsAuthenticated);

    /// <summary>One settings-registry entry; see <see cref="SettingDescriptors"/>.</summary>
    internal sealed class SettingDescriptor
    {
        public SettingDescriptor(string key, SettingExposure exposure, Func<SettingContext, object?> getValue, string? userSettingsProperty)
        {
            Key = key;
            Exposure = exposure;
            GetValue = getValue;
            UserSettingsProperty = userSettingsProperty;
        }

        /// <summary>PascalCase payload key. Matches the PluginConfiguration property name except for computed/renamed fields.</summary>
        public string Key { get; }

        public SettingExposure Exposure { get; }

        /// <summary>Produces the payload value; for computed fields this is where the projection logic lives.</summary>
        public Func<SettingContext, object?> GetValue { get; }

        /// <summary>
        /// Name of the paired <see cref="UserSettings"/> property when this admin setting is the
        /// per-user default (the seeding map lives in UserSettingsController.GetUserSettingsSettings).
        /// Differs from <see cref="Key"/> for historical renames, e.g. WatchProgressDefaultMode →
        /// WatchProgressMode. Null when the setting is admin-only.
        /// </summary>
        public string? UserSettingsProperty { get; }
    }

    /// <summary>
    /// Settings-as-data registry: ONE declaration per setting carrying its payload key, endpoint
    /// exposure, per-user-override pairing and value accessor. This is the single source of truth
    /// that drives the GetPublicConfig/GetPrivateConfig projections and the
    /// PluginConfiguration ↔ UserSettings drift-catcher test.
    ///
    /// Ground rules:
    ///  - The exposure lists are WHITELISTS. A setting not registered as Public/Private/Both
    ///    never reaches any client. Secrets (TMDB_API_KEY, JellyseerrApiKey, Sonarr/RadarrApiKey,
    ///    per-instance ApiKey) must never get a Public/Private descriptor — only derived,
    ///    non-secret values (e.g. TmdbEnabled) may be projected.
    ///  - Entries with Neither exposure exist purely to declare a per-user pairing for admin
    ///    defaults that are delivered via per-user settings.json seeding instead of public-config.
    ///  - The payload contract (key set AND values) is pinned by the golden snapshots in
    ///    JellyfinElevate.Tests/Snapshots — when a golden test fails, fix the descriptor,
    ///    never the snapshot.
    /// </summary>
    internal static class SettingDescriptors
    {
        internal static readonly IReadOnlyList<SettingDescriptor> All = BuildRegistry();

        /// <summary>Builds the payload dictionary for one endpoint. Key order = registry order.</summary>
        internal static Dictionary<string, object?> BuildPayload(SettingExposure endpoint, SettingContext context)
        {
            var payload = new Dictionary<string, object?>();
            foreach (var descriptor in All)
            {
                if (descriptor.Exposure == endpoint || descriptor.Exposure == SettingExposure.Both)
                {
                    payload[descriptor.Key] = descriptor.GetValue(context);
                }
            }

            return payload;
        }

        // ---- Small helper factories. Prefer these over reflection magic: every setting below is
        // ---- a plain, greppable declaration whose lambda binds the property at compile time. ----

        /// <summary>Public-config setting (admin-only, no per-user override).</summary>
        private static SettingDescriptor Public(string key, Func<PluginConfiguration, object?> get)
            => new(key, SettingExposure.Public, ctx => get(ctx.Config), userSettingsProperty: null);

        /// <summary>Public-config setting that is also the admin default for a per-user override.</summary>
        private static SettingDescriptor PublicUser(string key, Func<PluginConfiguration, object?> get, string userSetting)
            => new(key, SettingExposure.Public, ctx => get(ctx.Config), userSettingsProperty: userSetting);

        /// <summary>Public-config setting whose value depends on the caller (e.g. redacted pre-login).</summary>
        private static SettingDescriptor PublicContextual(string key, Func<SettingContext, object?> get)
            => new(key, SettingExposure.Public, get, userSettingsProperty: null);

        /// <summary>Private-config (admin-only endpoint) setting.</summary>
        private static SettingDescriptor Private(string key, Func<PluginConfiguration, object?> get)
            => new(key, SettingExposure.Private, ctx => get(ctx.Config), userSettingsProperty: null);

        /// <summary>Never projected; declares the admin default ↔ per-user override pairing only.</summary>
        private static SettingDescriptor ServerOnlyUser(string key, Func<PluginConfiguration, object?> get, string userSetting)
            => new(key, SettingExposure.Neither, ctx => get(ctx.Config), userSettingsProperty: userSetting);

        private static IReadOnlyList<SettingDescriptor> BuildRegistry()
        {
            var descriptors = new[]
            {
                // =========================== public-config ===========================

                // Jellyfin Elevate Settings
                // TmdbEnabled: expose whether TMDB is configured as a boolean so all users
                // (including non-admin) can use TMDB-dependent features like Reviews and
                // Elsewhere without leaking the actual API key.
                Public("TmdbEnabled", c => !string.IsNullOrWhiteSpace(c.TMDB_API_KEY)),
                Public("ToastDuration", c => c.ToastDuration),
                Public("HelpPanelAutocloseDelay", c => c.HelpPanelAutocloseDelay),
                Public("EnableCustomSplashScreen", c => c.EnableCustomSplashScreen),
                Public("SplashScreenImageUrl", c => c.SplashScreenImageUrl),
                // Public (incl. pre-login): the client-side asset-url map
                // (src/core/asset-urls.ts) decides local-cache vs original-CDN
                // URLs with this flag, and some assets load before login.
                Public("AssetCacheEnabled", c => c.AssetCacheEnabled),

                // Jellyfin Elsewhere Settings
                Public("ElsewhereEnabled", c => c.ElsewhereEnabled),
                Public("DEFAULT_REGION", c => c.DEFAULT_REGION),
                Public("DEFAULT_PROVIDERS", c => c.DEFAULT_PROVIDERS),
                Public("IGNORE_PROVIDERS", c => c.IGNORE_PROVIDERS),
                Public("ElsewhereCustomBrandingText", c => c.ElsewhereCustomBrandingText),
                Public("ElsewhereCustomBrandingImageUrl", c => c.ElsewhereCustomBrandingImageUrl),
                Public("ClearLocalStorageTimestamp", c => c.ClearLocalStorageTimestamp),
                Public("ClearTranslationCacheTimestamp", c => c.ClearTranslationCacheTimestamp),

                // Default User Settings
                PublicUser("AutoPauseEnabled", c => c.AutoPauseEnabled, nameof(UserSettings.AutoPauseEnabled)),
                PublicUser("AutoResumeEnabled", c => c.AutoResumeEnabled, nameof(UserSettings.AutoResumeEnabled)),
                PublicUser("AutoPipEnabled", c => c.AutoPipEnabled, nameof(UserSettings.AutoPipEnabled)),
                PublicUser("AutoSkipIntro", c => c.AutoSkipIntro, nameof(UserSettings.AutoSkipIntro)),
                PublicUser("AutoSkipOutro", c => c.AutoSkipOutro, nameof(UserSettings.AutoSkipOutro)),
                PublicUser("LongPress2xEnabled", c => c.LongPress2xEnabled, nameof(UserSettings.LongPress2xEnabled)),
                PublicUser("RandomButtonEnabled", c => c.RandomButtonEnabled, nameof(UserSettings.RandomButtonEnabled)),
                PublicUser("RandomIncludeMovies", c => c.RandomIncludeMovies, nameof(UserSettings.RandomIncludeMovies)),
                PublicUser("RandomIncludeShows", c => c.RandomIncludeShows, nameof(UserSettings.RandomIncludeShows)),
                PublicUser("RandomUnwatchedOnly", c => c.RandomUnwatchedOnly, nameof(UserSettings.RandomUnwatchedOnly)),
                PublicUser("ShowWatchProgress", c => c.ShowWatchProgress, nameof(UserSettings.ShowWatchProgress)),
                PublicUser("ShowFileSizes", c => c.ShowFileSizes, nameof(UserSettings.ShowFileSizes)),
                PublicUser("RemoveContinueWatchingEnabled", c => c.RemoveContinueWatchingEnabled, nameof(UserSettings.RemoveContinueWatchingEnabled)),
                PublicUser("ShowAudioLanguages", c => c.ShowAudioLanguages, nameof(UserSettings.ShowAudioLanguages)),
                // Per-user shortcut overrides live in shortcuts.json (UserShortcuts), not UserSettings.
                Public("Shortcuts", c => c.Shortcuts),
                Public("ShowReviews", c => c.ShowReviews),
                Public("ShowUserReviews", c => c.ShowUserReviews),
                PublicUser("ReviewsExpandedByDefault", c => c.ReviewsExpandedByDefault, nameof(UserSettings.ReviewsExpandedByDefault)),
                Public("HideReviewsFromHiddenUsers", c => c.HideReviewsFromHiddenUsers),
                Public("HideReviewsFromDisabledUsers", c => c.HideReviewsFromDisabledUsers),
                Public("ShowReleaseDates", c => c.ShowReleaseDates),
                Public("ShowUserRatingOnPosters", c => c.ShowUserRatingOnPosters),
                Public("ShowUserRatingDash", c => c.ShowUserRatingDash),
                PublicUser("PauseScreenEnabled", c => c.PauseScreenEnabled, nameof(UserSettings.PauseScreenEnabled)),
                PublicUser("QualityTagsEnabled", c => c.QualityTagsEnabled, nameof(UserSettings.QualityTagsEnabled)),
                PublicUser("ShowResolutionTag", c => c.ShowResolutionTag, nameof(UserSettings.ShowResolutionTag)),
                PublicUser("ShowSourceTag", c => c.ShowSourceTag, nameof(UserSettings.ShowSourceTag)),
                PublicUser("ShowDynamicRangeTag", c => c.ShowDynamicRangeTag, nameof(UserSettings.ShowDynamicRangeTag)),
                PublicUser("ShowSpecialFormatTag", c => c.ShowSpecialFormatTag, nameof(UserSettings.ShowSpecialFormatTag)),
                PublicUser("ShowVideoCodecTag", c => c.ShowVideoCodecTag, nameof(UserSettings.ShowVideoCodecTag)),
                PublicUser("ShowAudioInfoTag", c => c.ShowAudioInfoTag, nameof(UserSettings.ShowAudioInfoTag)),
                // Admin defaults are int, per-user overrides are int? — pinned by the pairing test.
                PublicUser("ResolutionTagOrder", c => c.ResolutionTagOrder, nameof(UserSettings.ResolutionTagOrder)),
                PublicUser("SourceTagOrder", c => c.SourceTagOrder, nameof(UserSettings.SourceTagOrder)),
                PublicUser("DynamicRangeTagOrder", c => c.DynamicRangeTagOrder, nameof(UserSettings.DynamicRangeTagOrder)),
                PublicUser("SpecialFormatTagOrder", c => c.SpecialFormatTagOrder, nameof(UserSettings.SpecialFormatTagOrder)),
                PublicUser("VideoCodecTagOrder", c => c.VideoCodecTagOrder, nameof(UserSettings.VideoCodecTagOrder)),
                PublicUser("AudioInfoTagOrder", c => c.AudioInfoTagOrder, nameof(UserSettings.AudioInfoTagOrder)),
                PublicUser("GenreTagsEnabled", c => c.GenreTagsEnabled, nameof(UserSettings.GenreTagsEnabled)),
                PublicUser("LanguageTagsEnabled", c => c.LanguageTagsEnabled, nameof(UserSettings.LanguageTagsEnabled)),
                PublicUser("RatingTagsEnabled", c => c.RatingTagsEnabled, nameof(UserSettings.RatingTagsEnabled)),
                PublicUser("PeopleTagsEnabled", c => c.PeopleTagsEnabled, nameof(UserSettings.PeopleTagsEnabled)),
                Public("DisableAllShortcuts", c => c.DisableAllShortcuts),
                // Historical renames: the admin defaults kept their configPage names while the
                // per-user properties got UI-oriented names.
                PublicUser("DefaultSubtitleStyle", c => c.DefaultSubtitleStyle, nameof(UserSettings.SelectedStylePresetIndex)),
                PublicUser("DefaultSubtitleSize", c => c.DefaultSubtitleSize, nameof(UserSettings.SelectedFontSizePresetIndex)),
                PublicUser("DefaultSubtitleFont", c => c.DefaultSubtitleFont, nameof(UserSettings.SelectedFontFamilyPresetIndex)),
                PublicUser("DisableCustomSubtitleStyles", c => c.DisableCustomSubtitleStyles, nameof(UserSettings.DisableCustomSubtitleStyles)),
                PublicUser("DefaultLanguage", c => c.DefaultLanguage, nameof(UserSettings.DisplayLanguage)),
                // Overlay positions
                PublicUser("QualityTagsPosition", c => c.QualityTagsPosition, nameof(UserSettings.QualityTagsPosition)),
                PublicUser("GenreTagsPosition", c => c.GenreTagsPosition, nameof(UserSettings.GenreTagsPosition)),
                PublicUser("LanguageTagsPosition", c => c.LanguageTagsPosition, nameof(UserSettings.LanguageTagsPosition)),
                PublicUser("RatingTagsPosition", c => c.RatingTagsPosition, nameof(UserSettings.RatingTagsPosition)),
                PublicUser("ShowRatingInPlayer", c => c.ShowRatingInPlayer, nameof(UserSettings.ShowRatingInPlayer)),

                Public("TagsCacheTtlDays", c => c.TagsCacheTtlDays),
                Public("DisableTagsOnSearchPage", c => c.DisableTagsOnSearchPage),
                PublicUser("TagsHideOnHover", c => c.TagsHideOnHover, nameof(UserSettings.TagsHideOnHover)),
                Public("TagCacheServerMode", c => c.TagCacheServerMode),
                Public("EnableTagsLocalStorageFallback", c => c.EnableTagsLocalStorageFallback),

                // Seerr Search Settings
                Public("JellyseerrEnabled", c => c.JellyseerrEnabled),
                Public("JellyseerrShowSearchResults", c => c.JellyseerrShowSearchResults),
                Public("JellyseerrShowReportButton", c => c.JellyseerrShowReportButton),
                Public("JellyseerrShowIssueIndicator", c => c.JellyseerrShowIssueIndicator),
                Public("JellyseerrEnable4KRequests", c => c.JellyseerrEnable4KRequests),
                Public("JellyseerrEnable4KTvRequests", c => c.JellyseerrEnable4KTvRequests),
                Public("ShowCollectionsInSearch", c => c.ShowCollectionsInSearch),
                Public("JellyseerrShowAdvanced", c => c.JellyseerrShowAdvanced),
                Public("JellyseerrShowQuotaInfo", c => c.JellyseerrShowQuotaInfo),
                Public("ShowElsewhereOnJellyseerr", c => c.ShowElsewhereOnJellyseerr),
                Public("JellyseerrUseMoreInfoModal", c => c.JellyseerrUseMoreInfoModal),
                Public("AddRequestedMediaToWatchlist", c => c.AddRequestedMediaToWatchlist),
                Public("SyncJellyseerrWatchlist", c => c.SyncJellyseerrWatchlist),
                Public("JellyseerrAutoImportUsers", c => c.JellyseerrAutoImportUsers),
                Public("JellyseerrShowSimilar", c => c.JellyseerrShowSimilar),
                Public("JellyseerrShowRecommended", c => c.JellyseerrShowRecommended),
                Public("JellyseerrShowRequestMoreOnSeries", c => c.JellyseerrShowRequestMoreOnSeries),
                Public("JellyseerrShowNetworkDiscovery", c => c.JellyseerrShowNetworkDiscovery),
                Public("JellyseerrShowGenreDiscovery", c => c.JellyseerrShowGenreDiscovery),
                Public("JellyseerrShowTagDiscovery", c => c.JellyseerrShowTagDiscovery),
                Public("JellyseerrShowPersonDiscovery", c => c.JellyseerrShowPersonDiscovery),
                // Was missing from the hand-written projection: the configPage toggle saved it,
                // but the client gate `pluginConfig.JellyseerrShowCollectionDiscovery !== false`
                // never saw the key, so disabling collection discovery had no effect.
                Public("JellyseerrShowCollectionDiscovery", c => c.JellyseerrShowCollectionDiscovery),
                Public("JellyseerrExcludeLibraryItems", c => c.JellyseerrExcludeLibraryItems),
                Public("JellyseerrExcludeBlocklistedItems", c => c.JellyseerrExcludeBlocklistedItems),
                // Discovery & Trending — the client reads these to gate the feature and resolve the
                // default row set (user customization overrides client-side).
                Public("DiscoveryEnabled", c => c.DiscoveryEnabled),
                Public("DiscoveryLibraryTab", c => c.DiscoveryLibraryTab),
                Public("DiscoveryHomeTab", c => c.DiscoveryHomeTab),
                Public("DiscoveryRowTrending", c => c.DiscoveryRowTrending),
                Public("DiscoveryRowPopular", c => c.DiscoveryRowPopular),
                Public("DiscoveryRowUpcoming", c => c.DiscoveryRowUpcoming),
                Public("DiscoveryRowTopRated", c => c.DiscoveryRowTopRated),
                Public("DiscoveryRowWatchlist", c => c.DiscoveryRowWatchlist),
                Public("DiscoveryGenreRows", c => c.DiscoveryGenreRows),
                Public("JellyseerrDisableCache", c => c.JellyseerrDisableCache),
                // Only authenticated callers see internal Seerr URLs — they're used by
                // client-side deep links and would otherwise leak network topology to
                // unauthenticated visitors hitting the login page.
                PublicContextual("JellyseerrBaseUrl", ctx =>
                {
                    if (!ctx.IsAuthenticated)
                    {
                        return string.Empty;
                    }

                    var jellyseerrBaseUrl = string.Empty;
                    try
                    {
                        if (!string.IsNullOrWhiteSpace(ctx.Config.JellyseerrUrls))
                        {
                            jellyseerrBaseUrl = ctx.Config.JellyseerrUrls
                                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                                .Select(u => u.Trim())
                                .FirstOrDefault() ?? string.Empty;
                        }
                    }
                    catch { /* ignore */ }
                    return jellyseerrBaseUrl;
                }),
                PublicContextual("JellyseerrUrlMappings", ctx =>
                    ctx.IsAuthenticated ? (ctx.Config.JellyseerrUrlMappings ?? string.Empty) : string.Empty),

                // Bookmarks Settings
                Public("BookmarksEnabled", c => c.BookmarksEnabled),
                Public("BookmarksUsePluginPages", c => c.BookmarksUsePluginPages),
                Public("BookmarksUseCustomTabs", c => c.BookmarksUseCustomTabs),
                Public("BookmarksUseNativeTab", c => c.BookmarksUseNativeTab),

                // Arr Links Settings
                Public("ArrLinksEnabled", c => c.ArrLinksEnabled),
                Public("ShowArrLinksAsText", c => c.ShowArrLinksAsText),
                Public("ArrLinksShowStatusSingle", c => c.ArrLinksShowStatusSingle),

                // Arr Search Settings (client hides the action-sheet items when off;
                // endpoints stay policy-gated). No secrets — plain booleans.
                Public("ArrSearchEnabled", c => c.ArrSearchEnabled),
                Public("ArrSearchManageEnabled", c => c.ArrSearchManageEnabled),

                // Arr Tags Sync Settings
                Public("ArrTagsSyncEnabled", c => c.ArrTagsSyncEnabled),
                Public("ArrTagsPrefix", c => c.ArrTagsPrefix),
                Public("ArrTagsShowAsLinks", c => c.ArrTagsShowAsLinks),
                Public("ArrTagsLinksFilter", c => c.ArrTagsLinksFilter),
                Public("ArrTagsLinksHideFilter", c => c.ArrTagsLinksHideFilter),

                // Letterboxd Settings
                Public("LetterboxdEnabled", c => c.LetterboxdEnabled),
                Public("ShowLetterboxdLinkAsText", c => c.ShowLetterboxdLinkAsText),
                // Metadata Icons (Druidblack)
                Public("MetadataIconsEnabled", c => c.MetadataIconsEnabled),

                // Icon Settings
                Public("UseIcons", c => c.UseIcons),
                Public("IconStyle", c => c.IconStyle),

                // Extras Settings
                Public("ColoredRatingsEnabled", c => c.ColoredRatingsEnabled),
                Public("ThemeSelectorEnabled", c => c.ThemeSelectorEnabled),
                Public("ColoredActivityIconsEnabled", c => c.ColoredActivityIconsEnabled),
                Public("PluginIconsEnabled", c => c.PluginIconsEnabled),
                Public("EnableLoginImage", c => c.EnableLoginImage),
                Public("ActiveStreamsEnabled", c => c.ActiveStreamsEnabled),
                Public("ActiveStreamsAllUsers", c => c.ActiveStreamsAllUsers),

                // Requests Page Settings
                Public("DownloadsPageEnabled", c => c.DownloadsPageEnabled),
                Public("DownloadsPageShowIssues", c => c.DownloadsPageShowIssues),
                Public("ShowDownloadsInRequests", c => c.ShowDownloadsInRequests),
                Public("DownloadsUsePluginPages", c => c.DownloadsUsePluginPages),
                Public("DownloadsUseCustomTabs", c => c.DownloadsUseCustomTabs),
                Public("DownloadsUseNativeTab", c => c.DownloadsUseNativeTab),
                Public("DownloadsPagePollingEnabled", c => c.DownloadsPagePollingEnabled),
                Public("DownloadsPollIntervalSeconds", c => c.DownloadsPollIntervalSeconds),
                Public("DownloadsFilterByUserRequests", c => c.DownloadsFilterByUserRequests),

                // Calendar Page Settings
                Public("CalendarPageEnabled", c => c.CalendarPageEnabled),
                Public("CalendarUseCustomTabs", c => c.CalendarUseCustomTabs),
                Public("CalendarUsePluginPages", c => c.CalendarUsePluginPages),
                Public("CalendarUseNativeTab", c => c.CalendarUseNativeTab),
                Public("CalendarFirstDayOfWeek", c => c.CalendarFirstDayOfWeek),
                Public("CalendarTimeFormat", c => c.CalendarTimeFormat),
                Public("CalendarHighlightFavorites", c => c.CalendarHighlightFavorites),
                Public("CalendarHighlightWatchedSeries", c => c.CalendarHighlightWatchedSeries),
                Public("CalendarFilterByLibraryAccess", c => c.CalendarFilterByLibraryAccess),
                Public("CalendarShowOnlyRequested", c => c.CalendarShowOnlyRequested),
                Public("CalendarForceOnlyRequested", c => c.CalendarForceOnlyRequested),

                // Hidden Content Settings
                Public("HiddenContentEnabled", c => c.HiddenContentEnabled),
                Public("HiddenContentUsePluginPages", c => c.HiddenContentUsePluginPages),
                Public("HiddenContentUseCustomTabs", c => c.HiddenContentUseCustomTabs),
                Public("HiddenContentUseNativeTab", c => c.HiddenContentUseNativeTab),
                Public("HiddenContentAdmin", c => c.HiddenContentAdmin),

                // Spoiler Guard Settings. Only the keys the client scripts need
                // are projected: the master switch + the per-category strip
                // toggles the settings panel exposes as user opt-outs, plus the
                // strict-refresh flag. Everything else (Mode, Intensity, Artwork,
                // KeepMoviePosters, CastMode, Placeholder, AutoEnable*) is
                // server-side only — the dashboard config page edits the whole
                // config object directly, so those need no descriptor.
                Public("SpoilerBlurEnabled", c => c.SpoilerBlurEnabled),
                Public("SpoilerStripOverview", c => c.SpoilerStripOverview),
                Public("SpoilerStripTags", c => c.SpoilerStripTags),
                Public("SpoilerStripChapters", c => c.SpoilerStripChapters),
                Public("SpoilerStripTaglines", c => c.SpoilerStripTaglines),
                Public("SpoilerStripRatings", c => c.SpoilerStripRatings),
                Public("SpoilerStripPremiereDate", c => c.SpoilerStripPremiereDate),
                Public("SpoilerReplaceTitle", c => c.SpoilerReplaceTitle),
                Public("SpoilerStripCast", c => c.SpoilerStripCast),
                Public("SpoilerStripReviews", c => c.SpoilerStripReviews),
                Public("SpoilerBlurStrictRefresh", c => c.SpoilerBlurStrictRefresh),

                // Maintenance Mode
                Public("MaintenanceModeEnabled", c => c.MaintenanceModeEnabled),
                Public("MaintenanceModeMessage", c => c.MaintenanceModeMessage),
                Public("MaintenanceModeAction", c => c.MaintenanceModeAction),
                // The targeted-user GUID list enumerates specific accounts and is sensitive
                // topology; redact it for anonymous/pre-login callers (mirrors the Seerr URL
                // redaction above). MaintenanceModeMessage/Action stay Public because the
                // login-page maintenance banner legitimately needs them pre-auth.
                PublicContextual("MaintenanceModeAffectedUsers",
                    ctx => ctx.IsAuthenticated ? (ctx.Config.MaintenanceModeAffectedUsers ?? "all") : string.Empty),

                // =========================== private-config ===========================

                // For Arr Links (legacy single-instance fields, kept for backward compat)
                Private("SonarrUrl", c => c.SonarrUrl),
                Private("RadarrUrl", c => c.RadarrUrl),
                Private("BazarrUrl", c => c.BazarrUrl),
                Private("SonarrUrlMappings", c => c.SonarrUrlMappings),
                Private("RadarrUrlMappings", c => c.RadarrUrlMappings),
                Private("BazarrUrlMappings", c => c.BazarrUrlMappings),

                // Multi-instance Sonarr/Radarr (no API keys exposed). Enabled flag is exposed so
                // the config page can render a per-instance toggle and arr-links can filter
                // disabled instances from the dropdown without a round-trip.
                Private("SonarrInstances", c => c.GetSonarrInstances().Select(i => new { i.Name, i.Url, i.UrlMappings, i.Enabled })),
                Private("RadarrInstances", c => c.GetRadarrInstances().Select(i => new { i.Name, i.Url, i.UrlMappings, i.Enabled })),

                // Corruption flags so the frontend can surface a toast without waiting for an
                // action endpoint to round-trip a corruption error envelope.
                Private("SonarrInstancesCorrupt", c => c.IsSonarrInstancesCorrupt()),
                Private("RadarrInstancesCorrupt", c => c.IsRadarrInstancesCorrupt()),

                // ================= server-only admin defaults with per-user overrides =================
                // These never appear in public/private-config; they reach the client through the
                // per-user settings.json seeded in UserSettingsController.GetUserSettingsSettings.

                ServerOnlyUser("PauseScreenDelaySeconds", c => c.PauseScreenDelaySeconds, nameof(UserSettings.PauseScreenDelaySeconds)),
                ServerOnlyUser("WatchProgressDefaultMode", c => c.WatchProgressDefaultMode, nameof(UserSettings.WatchProgressMode)),
                ServerOnlyUser("WatchProgressTimeFormat", c => c.WatchProgressTimeFormat, nameof(UserSettings.WatchProgressTimeFormat)),
            };

            var duplicates = descriptors
                .GroupBy(d => d.Key, StringComparer.Ordinal)
                .Where(g => g.Count() > 1)
                .Select(g => g.Key)
                .ToList();
            if (duplicates.Count > 0)
            {
                throw new InvalidOperationException($"Duplicate setting descriptor keys: {string.Join(", ", duplicates)}");
            }

            return descriptors;
        }
    }
}
