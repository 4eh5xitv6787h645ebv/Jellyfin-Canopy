// src/core/asset-urls.test.ts
//
// Pins the client half of the third-party asset disconnection: the
// original↔local URL map, the AssetCacheEnabled toggle (ONE lookup decides
// CDN vs local) and the parameterized family helpers.

import { afterEach, describe, expect, it } from 'vitest';
import { JE } from '../globals';
import {
    ASSET_CDN_URLS,
    assetUrl,
    flagPngUrl,
    flagSvgUrl,
    localAssetsEnabled,
    themeCssUrl
} from './asset-urls';

// The only third-party hosts the ORIGINAL urls may live on — the client twin
// of the server manifest's AllowedUpstreamHosts (plus the poster fallback's
// legacy image host, which the server never fetches: it ships embedded).
const KNOWN_CDN_HOSTS = [
    'cdn.jsdelivr.net',
    'cdnjs.cloudflare.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'flagcdn.com',
    'i.ibb.co',
];

afterEach(() => {
    delete JE.pluginConfig.AssetCacheEnabled;
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
            .toBe('http://jellyfin.test/JellyfinEnhanced/assets/icons/seerr.svg');
    });

    it('serves from the local asset route when AssetCacheEnabled is true', () => {
        JE.pluginConfig.AssetCacheEnabled = true;
        expect(assetUrl('fonts/material-symbols-rounded.woff2'))
            .toBe('http://jellyfin.test/JellyfinEnhanced/assets/fonts/material-symbols-rounded.woff2');
    });

    it('falls back to the exact original CDN URL when disabled', () => {
        JE.pluginConfig.AssetCacheEnabled = false;
        expect(localAssetsEnabled()).toBe(false);
        expect(assetUrl('icons/seerr.svg')).toBe('https://cdn.jsdelivr.net/gh/selfhst/icons/svg/seerr.svg');
        expect(assetUrl('jellyseerr/poster-fallback.svg'))
            .toBe('https://i.ibb.co/fdbkXQdP/jellyseerr-poster-not-found.png');
    });
});

describe('family helpers', () => {
    it('flagSvgUrl builds local flag URLs and lowercases the code', () => {
        expect(flagSvgUrl('US')).toBe('http://jellyfin.test/JellyfinEnhanced/assets/flags/4x3/us.svg');
    });

    it('flagPngUrl builds local flag URLs and lowercases the code', () => {
        expect(flagPngUrl('De')).toBe('http://jellyfin.test/JellyfinEnhanced/assets/flags/w20/de.png');
    });

    it('themeCssUrl builds local theme URLs', () => {
        expect(themeCssUrl('ocean.css')).toBe('http://jellyfin.test/JellyfinEnhanced/assets/themes/ocean.css');
    });

    it('family helpers fall back to the original CDN URLs when disabled', () => {
        JE.pluginConfig.AssetCacheEnabled = false;
        expect(flagSvgUrl('us')).toBe('https://cdnjs.cloudflare.com/ajax/libs/flag-icons/7.2.1/flags/4x3/us.svg');
        expect(flagPngUrl('us')).toBe('https://flagcdn.com/w20/us.png');
        expect(themeCssUrl('ocean.css')).toBe('https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfish/colors/ocean.css');
    });
});
