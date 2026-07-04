// src/core/asset-urls.ts
//
// PERF: no remote assets — served from the local asset cache.
//
// The single client-side map between the plugin's locally served assets
// (/JellyfinEnhanced/assets/<key>, mirrored server-side by AssetCacheService
// and refreshed on a ~24h schedule) and their original third-party CDN URLs.
// With the asset cache enabled (AssetCacheEnabled, default ON) every URL
// returned here is same-origin, so browsers make ZERO requests to third-party
// CDNs; when an admin disables it, the exact original CDN URL is used instead
// — which is why every key keeps its upstream twin in this one table.
//
// The key set is the client twin of the server manifest
// (Services/AssetCacheManifest.cs); keep the two in sync when adding assets.

import { JE } from '../globals';

/** Original CDN location of every mirrored asset, keyed by its local cache key. */
export const ASSET_CDN_URLS = Object.freeze({
    'fonts/material-symbols-rounded.woff2': 'https://fonts.gstatic.com/s/materialsymbolsrounded/v258/syl0-zNym6YjUruM-QrEh7-nyTnjDwKNJ_190FjpZIvDmUSVOK7BDB_Qb9vUSzq3wzLK-P0J-V_Zs-QtQth3-jOcbTCVpeRL2w5rwZu2rIelXxc.woff2',
    'fonts/material-symbols-outlined.css': 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@48,400,0,0',
    'metadata-icons/public-icon.css': 'https://cdn.jsdelivr.net/gh/Druidblack/jellyfin-icon-metadata/public-icon.css',
    'ratings/ratings.css': 'https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Enhanced@main/css/ratings.css',
    'icons/seerr.svg': 'https://cdn.jsdelivr.net/gh/selfhst/icons/svg/seerr.svg',
    'icons/sonarr.svg': 'https://cdn.jsdelivr.net/gh/selfhst/icons/svg/sonarr.svg',
    'icons/radarr-light-hybrid-light.svg': 'https://cdn.jsdelivr.net/gh/selfhst/icons/svg/radarr-light-hybrid-light.svg',
    'icons/bazarr.svg': 'https://cdn.jsdelivr.net/gh/selfhst/icons/svg/bazarr.svg',
    'icons/letterboxd.svg': 'https://cdn.jsdelivr.net/gh/selfhst/icons/svg/letterboxd.svg',
    'icons/youtube.png': 'https://cdn.jsdelivr.net/gh/selfhst/icons@main/png/youtube.png',
    'icons/javascript.svg': 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/javascript.svg',
    'icons/jellyfish-favicon.ico': 'https://cdn.jsdelivr.net/gh/n00bcodr/jellyfish/logos/favicon.ico',
    'icons/jellyfin-helper-favicon.ico': 'https://cdn.jsdelivr.net/gh/JellyPlugins/jellyfin-helper@2.0.0.2/media/favicon.ico',
    'elsewhere/regions.txt': 'https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Elsewhere/resources/regions.txt',
    'elsewhere/providers.txt': 'https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Elsewhere/resources/providers.txt',
    'themer/jellyfin-logo-light.png': 'https://cdn.jsdelivr.net/gh/stpnwf/ZestyTheme@latest/images/logo/jellyfin-logo-light.png',
    // Embedded in the plugin DLL — the original i.ibb.co image is only the
    // asset-cache-disabled fallback; the local placeholder never needs a network.
    'jellyseerr/poster-fallback.svg': 'https://i.ibb.co/fdbkXQdP/jellyseerr-poster-not-found.png',
} as const);

export type AssetKey = keyof typeof ASSET_CDN_URLS;

/**
 * Whether third-party assets are served from the local plugin asset cache.
 * Defaults to true when the config has not loaded yet (matches the server
 * default), so no CDN request can slip out during startup.
 */
export function localAssetsEnabled(): boolean {
    return JE.pluginConfig?.AssetCacheEnabled !== false;
}

/** Resolves a local assets-route URL (base-url aware via ApiClient.getUrl). */
function localAssetUrl(key: string): string {
    return ApiClient.getUrl(`/JellyfinEnhanced/assets/${key}`);
}

/**
 * The URL to load a mirrored asset from: the local asset cache by default,
 * or the original CDN URL when the admin disabled local serving.
 * @param key - Cache key from {@link ASSET_CDN_URLS}.
 */
export function assetUrl(key: AssetKey): string {
    return localAssetsEnabled() ? localAssetUrl(key) : ASSET_CDN_URLS[key];
}

/**
 * Flag SVG (flag-icons 4x3 set) for a two-letter country code — served from
 * the local `flags/4x3/` asset family.
 * @param countryCode - ISO 3166-1 alpha-2 code, any case.
 */
export function flagSvgUrl(countryCode: string): string {
    const code = String(countryCode || '').toLowerCase();
    return localAssetsEnabled()
        ? localAssetUrl(`flags/4x3/${code}.svg`)
        : `https://cdnjs.cloudflare.com/ajax/libs/flag-icons/7.2.1/flags/4x3/${code}.svg`;
}

/**
 * Flag PNG (flagcdn w20 set) for a two-letter country code — served from the
 * local `flags/w20/` asset family.
 * @param countryCode - ISO 3166-1 alpha-2 code, any case.
 */
export function flagPngUrl(countryCode: string): string {
    const code = String(countryCode || '').toLowerCase();
    return localAssetsEnabled()
        ? localAssetUrl(`flags/w20/${code}.png`)
        : `https://flagcdn.com/w20/${code}.png`;
}

/**
 * Jellyfish theme-variant stylesheet URL (theme-selector) — served from the
 * local `themes/` asset entries.
 * @param fileName - Theme CSS file name from the fixed THEMES table, e.g. "ocean.css".
 */
export function themeCssUrl(fileName: string): string {
    return localAssetsEnabled()
        ? localAssetUrl(`themes/${fileName}`)
        : `https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfish/colors/${fileName}`;
}
