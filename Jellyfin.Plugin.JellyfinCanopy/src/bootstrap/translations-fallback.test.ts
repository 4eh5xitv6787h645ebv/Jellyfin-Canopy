// XCUT-7: the last-resort locale fetch (used only when AssetCacheEnabled === false)
// pointed at the UPSTREAM repo (n00bcodr/Jellyfin-Enhanced/main) — a different
// codebase whose key set differs, so it would introduce missing/mismatched
// strings. It must resolve against this repo (Jellyfin-Canopy) on main.
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

const TEST_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const src = ts.sys.readFile(TEST_PATH.replace(/translations-fallback\.test\.ts$/, 'translations.ts')) ?? '';

describe('translation GitHub fallback base (XCUT-7)', () => {
    const base = src.match(/const GITHUB_RAW_BASE\s*=\s*'([^']+)'/)?.[1];

    it('is defined', () => {
        expect(base, 'GITHUB_RAW_BASE not found').toBeTruthy();
    });

    it('points at this repo on the main branch, not upstream', () => {
        expect(base).toContain('4eh5xitv6787h645ebv/Jellyfin-Canopy');
        expect(base).toContain('/Jellyfin-Canopy/main/');
        expect(base).not.toContain('n00bcodr');
    });

    it('still resolves the plugin locales path', () => {
        expect(base).toContain('Jellyfin.Plugin.JellyfinCanopy/js/locales');
    });
});
