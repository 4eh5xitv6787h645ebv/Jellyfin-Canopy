using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    /// <summary>
    /// One exact third-party asset the plugin mirrors locally.
    /// </summary>
    /// <param name="Key">Relative cache key served at /JellyfinCanopy/assets/{Key}.</param>
    /// <param name="UpstreamUrl">The exact upstream URL. Its host MUST be in <see cref="AssetCacheManifest.AllowedUpstreamHosts"/>.</param>
    /// <param name="ContentType">Content-Type the asset is served with.</param>
    /// <param name="MaxBytes">Hard size cap; larger upstream responses are rejected and the last good copy kept.</param>
    /// <param name="Rewrite">True for CSS whose url(...) references must be rewritten to local derived assets.</param>
    /// <param name="AllowedDerivedPrefixes">
    /// For <see cref="Rewrite"/> entries: absolute-URL prefixes (matched ordinal-ignore-case) a url(...)
    /// reference may point at to become a locally cached derived asset. References outside these
    /// prefixes are left untouched. Never host-wide — always repo/path scoped.
    /// </param>
    internal sealed record AssetDescriptor(
        string Key,
        string UpstreamUrl,
        string ContentType,
        long MaxBytes,
        bool Rewrite = false,
        IReadOnlyList<string>? AllowedDerivedPrefixes = null);

    /// <summary>
    /// A parameterized family of assets (e.g. one flag SVG per country code). The parameter is
    /// validated against a strict pattern before it may touch the URL template or the file system,
    /// so a family is NOT arbitrary proxying — it is a finite, enumerable set.
    /// </summary>
    /// <param name="KeyPrefix">Key prefix including trailing slash, e.g. "flags/4x3/".</param>
    /// <param name="KeySuffix">Key suffix, e.g. ".svg".</param>
    /// <param name="UrlTemplate">Upstream URL with {0} for the validated parameter.</param>
    /// <param name="ParamPattern">Anchored regex the parameter must fully match.</param>
    /// <param name="ContentType">Content-Type the assets are served with.</param>
    /// <param name="MaxBytes">Hard per-file size cap.</param>
    internal sealed record AssetFamilyDescriptor(
        string KeyPrefix,
        string KeySuffix,
        string UrlTemplate,
        Regex ParamPattern,
        string ContentType,
        long MaxBytes);

    /// <summary>
    /// An asset shipped inside the plugin DLL (no upstream at all) — the guaranteed-available tier.
    /// </summary>
    internal sealed record EmbeddedAssetDescriptor(string Key, string ResourceName, string ContentType);

    /// <summary>
    /// The STRICT allowlist of every remote asset the plugin's client code used to load from
    /// third-party CDNs, now mirrored by <see cref="AssetCacheService"/> and served from
    /// /JellyfinCanopy/assets/*. This manifest is the only source of upstream URLs — the cache
    /// never fetches anything that is not declared here (or derived, prefix-checked, from a
    /// Rewrite entry's CSS). The client-side twin of this table lives in src/core/asset-urls.ts.
    /// </summary>
    internal static class AssetCacheManifest
    {
        // Size caps: generous multiples of the current upstream sizes so routine upstream
        // growth never breaks the cache, while a hijacked/misbehaving upstream cannot fill
        // the disk. (Fonts are variable fonts, up to a few MB; icons/CSS are tiny.)
        private const long FontCap = 8 * 1024 * 1024;
        private const long CssCap = 1024 * 1024;
        private const long IconCap = 512 * 1024;
        private const long ImageCap = 8 * 1024 * 1024;
        private const long TextCap = 256 * 1024;

        /// <summary>Every host a manifest upstream (or derived reference) may live on.</summary>
        internal static readonly IReadOnlyList<string> AllowedUpstreamHosts = new[]
        {
            "cdn.jsdelivr.net",
            "cdnjs.cloudflare.com",
            "fonts.googleapis.com",
            "fonts.gstatic.com",
            "flagcdn.com",
            "raw.githubusercontent.com",
        };

        private static readonly string[] JellyfishThemeFiles =
        {
            "aurora.css", "banana.css", "coal.css", "coral.css", "forest.css",
            "grass.css", "jellyblue.css", "jellyflix.css", "jellypurple.css",
            "lavender.css", "midnight.css", "mint.css", "ocean.css", "peach.css",
            "watermelon.css",
        };

        internal static readonly IReadOnlyList<AssetDescriptor> StaticAssets = BuildStaticAssets();

        internal static readonly IReadOnlyList<AssetFamilyDescriptor> Families = new[]
        {
            // Language/audio flag SVGs (languagetags, details media info). The client only ever
            // derives two-letter lowercase ISO codes, so the parameter pattern is exactly that.
            new AssetFamilyDescriptor(
                "flags/4x3/",
                ".svg",
                "https://cdnjs.cloudflare.com/ajax/libs/flag-icons/7.2.1/flags/4x3/{0}.svg",
                new Regex("^[a-z]{2}$", RegexOptions.Compiled),
                "image/svg+xml",
                IconCap),
            // Birthplace flag PNGs (peopletags, Seerr more-info modal).
            new AssetFamilyDescriptor(
                "flags/w20/",
                ".png",
                "https://flagcdn.com/w20/{0}.png",
                new Regex("^[a-z]{2}$", RegexOptions.Compiled),
                "image/png",
                IconCap),
        };

        internal static readonly IReadOnlyList<EmbeddedAssetDescriptor> EmbeddedAssets = new[]
        {
            // Ship-safe poster placeholder: replaces the old i.ibb.co "poster not found" image.
            // Never fetched — an image-host URL is not a versioned artifact worth mirroring when a
            // native-looking placeholder can be guaranteed from the DLL itself.
            new EmbeddedAssetDescriptor(
                "jellyseerr/poster-fallback.svg",
                "Jellyfin.Plugin.JellyfinCanopy.Assets.poster-fallback.svg",
                "image/svg+xml"),
            // Canopy brand mark: the product logo for plugin-owned UI (settings
            // panel header). Brand identity ships in the DLL, never off a CDN.
            new EmbeddedAssetDescriptor(
                "branding/canopy-mark.svg",
                "Jellyfin.Plugin.JellyfinCanopy.Assets.canopy-mark.svg",
                "image/svg+xml"),
            // Colored ratings CSS: this repo's css/ratings.css is the source of truth
            // (rating fixes are PRs to this repo), embedded at build time so it is
            // guaranteed available without any network fetch.
            new EmbeddedAssetDescriptor(
                "ratings/ratings.css",
                "Jellyfin.Plugin.JellyfinCanopy.Assets.ratings.css",
                "text/css"),
        };

        /// <summary>Maps a derived asset's file extension to the Content-Type it is served with.</summary>
        internal static string ContentTypeForExtension(string extension) => extension.ToLowerInvariant() switch
        {
            ".woff2" => "font/woff2",
            ".woff" => "font/woff",
            ".png" => "image/png",
            ".svg" => "image/svg+xml",
            ".css" => "text/css",
            ".ico" => "image/x-icon",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".webp" => "image/webp",
            ".gif" => "image/gif",
            _ => "application/octet-stream",
        };

        private static IReadOnlyList<AssetDescriptor> BuildStaticAssets()
        {
            var jellyfishPrefixes = new[] { "https://cdn.jsdelivr.net/gh/n00bcodr/jellyfish" };

            var assets = new List<AssetDescriptor>
            {
                // -- Fonts -----------------------------------------------------------------
                // Material Symbols Rounded variable font: the single @font-face the client
                // injects (consolidated in src/core/ui-kit.ts) points here.
                new AssetDescriptor(
                    "fonts/material-symbols-rounded.woff2",
                    "https://fonts.gstatic.com/s/materialsymbolsrounded/v258/syl0-zNym6YjUruM-QrEh7-nyTnjDwKNJ_190FjpZIvDmUSVOK7BDB_Qb9vUSzq3wzLK-P0J-V_Zs-QtQth3-jOcbTCVpeRL2w5rwZu2rIelXxc.woff2",
                    "font/woff2",
                    FontCap),
                // Google Fonts stylesheet for Material Symbols Outlined (genre tags). Rewritten:
                // its @font-face src urls (fonts.gstatic.com) become local derived assets.
                new AssetDescriptor(
                    "fonts/material-symbols-outlined.css",
                    "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@48,400,0,0",
                    "text/css",
                    TextCap,
                    Rewrite: true,
                    AllowedDerivedPrefixes: new[] { "https://fonts.gstatic.com/s/materialsymbolsoutlined/" }),

                // -- Druidblack metadata icons ----------------------------------------------
                // The CSS internally references ~40 absolute icon URLs on two hosts, both
                // scoped to the same upstream repo — hence two repo-scoped derived prefixes.
                new AssetDescriptor(
                    "metadata-icons/public-icon.css",
                    "https://cdn.jsdelivr.net/gh/Druidblack/jellyfin-icon-metadata/public-icon.css",
                    "text/css",
                    CssCap,
                    Rewrite: true,
                    AllowedDerivedPrefixes: new[]
                    {
                        "https://cdn.jsdelivr.net/gh/Druidblack/jellyfin-icon-metadata",
                        "https://raw.githubusercontent.com/Druidblack/jellyfin-icon-metadata/",
                    }),

                // -- selfhst icons (MIT) ------------------------------------------------------
                new AssetDescriptor("icons/seerr.svg", "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/seerr.svg", "image/svg+xml", IconCap),
                new AssetDescriptor("icons/sonarr.svg", "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/sonarr.svg", "image/svg+xml", IconCap),
                new AssetDescriptor("icons/radarr-light-hybrid-light.svg", "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/radarr-light-hybrid-light.svg", "image/svg+xml", IconCap),
                new AssetDescriptor("icons/bazarr.svg", "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/bazarr.svg", "image/svg+xml", IconCap),
                new AssetDescriptor("icons/letterboxd.svg", "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/letterboxd.svg", "image/svg+xml", IconCap),
                new AssetDescriptor("icons/youtube.png", "https://cdn.jsdelivr.net/gh/selfhst/icons@main/png/youtube.png", "image/png", IconCap),

                // -- Plugin-list icon replacements (plugin-icons feature) ---------------------
                new AssetDescriptor("icons/javascript.svg", "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/javascript.svg", "image/svg+xml", IconCap),
                new AssetDescriptor("icons/jellyfish-favicon.ico", "https://cdn.jsdelivr.net/gh/n00bcodr/jellyfish/logos/favicon.ico", "image/x-icon", IconCap),
                new AssetDescriptor("icons/jellyfin-helper-favicon.ico", "https://cdn.jsdelivr.net/gh/JellyPlugins/jellyfin-helper@2.0.0.2/media/favicon.ico", "image/x-icon", IconCap),

                // -- Elsewhere region/provider data -------------------------------------------
                new AssetDescriptor("elsewhere/regions.txt", "https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Elsewhere/resources/regions.txt", "text/plain", TextCap),
                new AssetDescriptor("elsewhere/providers.txt", "https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Elsewhere/resources/providers.txt", "text/plain", TextCap),

                // -- Themer: Zesty logo fallback ----------------------------------------------
                new AssetDescriptor("themer/jellyfin-logo-light.png", "https://cdn.jsdelivr.net/gh/stpnwf/ZestyTheme@latest/images/logo/jellyfin-logo-light.png", "image/png", ImageCap),

                // -- Config-page documentation screenshots -------------------------------------
                // Referenced by static <img> tags in Configuration/configPage.html (relative
                // ../JellyfinCanopy/assets/... URLs with an onerror CDN fallback), so they are
                // not part of the client-side asset-urls.ts map.
                new AssetDescriptor("screenshots/ratings.png", "https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Enhanced@main/docs/images/ratings.png", "image/png", ImageCap),
                new AssetDescriptor("screenshots/theme-selector.png", "https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Enhanced@main/docs/images/theme-selector.png", "image/png", ImageCap),
                new AssetDescriptor("screenshots/colored-activity-icons.png", "https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Enhanced@main/docs/images/colored-activity-icons.png", "image/png", ImageCap),
                new AssetDescriptor("screenshots/login-image.png", "https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Enhanced@main/docs/images/login-image.png", "image/png", ImageCap),
                new AssetDescriptor("screenshots/plugin-icons.png", "https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Enhanced@main/docs/images/plugin-icons.png", "image/png", ImageCap),
            };

            // Jellyfish theme color variants (theme-selector). The theme CSS references logo +
            // background images inside the same repo (both "jellyfish" and "Jellyfish" casings
            // appear upstream — prefix matching is ordinal-ignore-case).
            assets.AddRange(JellyfishThemeFiles.Select(file => new AssetDescriptor(
                $"themes/{file}",
                $"https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfish/colors/{file}",
                "text/css",
                CssCap,
                Rewrite: true,
                AllowedDerivedPrefixes: jellyfishPrefixes)));

            return assets;
        }
    }
}
