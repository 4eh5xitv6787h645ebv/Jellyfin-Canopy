// src/core/asset-urls.test.ts
//
// Pins the client half of the third-party asset disconnection: the
// original↔local URL map, the AssetCacheEnabled toggle (ONE lookup decides
// CDN vs local) and the parameterized family helpers.

import { afterEach, describe, expect, it } from 'vitest';
import { JC } from '../globals';
import {
    ASSET_CDN_URLS,
    assetUrl,
    flagPngUrl,
    flagSvgUrl,
    localAssetsEnabled,
    themeCssUrl
} from './asset-urls';

// The only third-party hosts the ORIGINAL urls may live on — the client twin
// of the server manifest's AllowedUpstreamHosts. DLL-embedded assets
// (EMBEDDED_ASSET_KEYS) are not in this map: they have no CDN twin at all.
const KNOWN_CDN_HOSTS = [
    'cdn.jsdelivr.net',
    'cdnjs.cloudflare.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'flagcdn.com',
];

afterEach(() => {
    delete JC.pluginConfig.AssetCacheEnabled;
});

describe('ASSET_CDN_URLS map integrity', () => {
    it('every key is a safe relative cache key', () => {
        for (const key of Object.keys(ASSET_CDN_URLS)) {
            expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._@/-]*$/);
            expect(key).not.toContain('..');
            expect(key.startsWith('/')).toBe(false);
        }
    });

    it('every original URL is https on a known CDN host', () => {
        for (const url of Object.values(ASSET_CDN_URLS)) {
            const parsed = new URL(url);
            expect(parsed.protocol).toBe('https:');
            expect(KNOWN_CDN_HOSTS).toContain(parsed.hostname);
        }
    });
});

describe('assetUrl', () => {
    it('serves from the local asset route by default (config not loaded yet)', () => {
        expect(localAssetsEnabled()).toBe(true);
        expect(assetUrl('icons/seerr.svg'))
            .toBe('http://jellyfin.test/JellyfinCanopy/assets/icons/seerr.svg');
    });

    it('serves from the local asset route when AssetCacheEnabled is true', () => {
        JC.pluginConfig.AssetCacheEnabled = true;
        expect(assetUrl('fonts/material-symbols-rounded.woff2'))
            .toBe('http://jellyfin.test/JellyfinCanopy/assets/fonts/material-symbols-rounded.woff2');
    });

    it('falls back to the exact original CDN URL when disabled', () => {
        JC.pluginConfig.AssetCacheEnabled = false;
        expect(localAssetsEnabled()).toBe(false);
        expect(assetUrl('icons/seerr.svg')).toBe('https://cdn.jsdelivr.net/gh/selfhst/icons/svg/seerr.svg');
    });

    it('embedded assets stay on the local route even when the cache is disabled', () => {
        JC.pluginConfig.AssetCacheEnabled = false;
        expect(assetUrl('seerr/poster-fallback.svg'))
            .toBe('http://jellyfin.test/JellyfinCanopy/assets/seerr/poster-fallback.svg');
        expect(assetUrl('ratings/ratings.css'))
            .toBe('http://jellyfin.test/JellyfinCanopy/assets/ratings/ratings.css');
        expect(assetUrl('theme-studio/operational-surfaces.css'))
            .toBe('http://jellyfin.test/JellyfinCanopy/assets/theme-studio/operational-surfaces.css');
        expect(assetUrl('theme-studio/seerr-surfaces.css'))
            .toBe('http://jellyfin.test/JellyfinCanopy/assets/theme-studio/seerr-surfaces.css');
        expect(assetUrl('theme-studio/arr-surfaces.css'))
            .toBe('http://jellyfin.test/JellyfinCanopy/assets/theme-studio/arr-surfaces.css');
        expect(assetUrl('theme-studio/external-surfaces.css'))
            .toBe('http://jellyfin.test/JellyfinCanopy/assets/theme-studio/external-surfaces.css');
    });
});

describe('family helpers', () => {
    it('flagSvgUrl builds local flag URLs and lowercases the code', () => {
        expect(flagSvgUrl('US')).toBe('http://jellyfin.test/JellyfinCanopy/assets/flags/4x3/us.svg');
    });

    it('flagPngUrl builds local flag URLs and lowercases the code', () => {
        expect(flagPngUrl('De')).toBe('http://jellyfin.test/JellyfinCanopy/assets/flags/w20/de.png');
    });

    it('themeCssUrl builds local theme URLs', () => {
        expect(themeCssUrl('ocean.css')).toBe('http://jellyfin.test/JellyfinCanopy/assets/themes/ocean.css');
    });

    it('family helpers fall back to the original CDN URLs when disabled', () => {
        JC.pluginConfig.AssetCacheEnabled = false;
        expect(flagSvgUrl('us')).toBe('https://cdnjs.cloudflare.com/ajax/libs/flag-icons/7.2.1/flags/4x3/us.svg');
        expect(flagPngUrl('us')).toBe('https://flagcdn.com/w20/us.png');
        expect(themeCssUrl('ocean.css')).toBe('https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfish/colors/ocean.css');
    });
});
