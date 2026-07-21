import { describe, expect, it } from 'vitest';
import { themeConfiguration } from '../test/theme-studio-fixture';
import { officialJellyfinThemeMode } from './jellyfin-web-contract';
import JELLYFIN_WEB_THEME_CONTRACT from './jellyfin-web-theme.contract.json';
import { resolveTheme, type ThemeMediaState } from './resolver';
import { serializeThemeStyles } from './styles';

const baseMedia: ThemeMediaState = {
    viewportWidth: 1366,
    viewportHeight: 768,
    tv: false,
    darkScheme: true,
    reducedMotion: false,
    moreContrast: false,
    reducedTransparency: false,
    forcedColors: false,
    hover: true,
    coarsePointer: false,
    jellyfinTheme: 'dark',
};

describe('pinned Jellyfin Web theme contract', () => {
    it('pins source evidence, MUI naming, host ownership and the modern-only surface matrix', () => {
        expect(JELLYFIN_WEB_THEME_CONTRACT).toMatchObject({
            schemaVersion: 1,
            repository: 'https://github.com/jellyfin/jellyfin-web',
            commit: '3d7adb53480f02164041fdd983b3f7abc28d0fd9',
            mui: {
                cssVariablePrefix: 'jf',
                colorSchemeSelector: '[data-theme="%s"]',
                defaultColorScheme: 'dark',
            },
            hostOwnership: {
                themeAttribute: 'data-theme',
                themeChangeEvent: 'THEME_CHANGE',
                userPreference: 'appTheme',
                dashboardPreference: 'dashboardTheme',
                dashboardSwitchesTheme: true,
            },
            canopySurfacePolicy: {
                supported: ['phone', 'desktop', 'wide'],
                unsupported: ['legacy', 'tablet', 'tv'],
                dashboardRequiresOptIn: true,
            },
        });
        expect(Object.keys(JELLYFIN_WEB_THEME_CONTRACT.sources).sort()).toEqual([
            'src/components/ThemeCss.tsx',
            'src/scripts/autoThemes.js',
            'src/scripts/themeManager.js',
            'src/themes/index.ts',
        ]);
        for (const digest of Object.values(JELLYFIN_WEB_THEME_CONTRACT.sources)) {
            expect(digest).toMatch(/^[0-9a-f]{64}$/);
        }
    });

    it('classifies every official built-in theme, including Apple TV as light', () => {
        expect(JELLYFIN_WEB_THEME_CONTRACT.builtInThemes).toEqual({
            appletv: 'light',
            blueradiance: 'dark',
            dark: 'dark',
            light: 'light',
            purplehaze: 'dark',
            wmc: 'dark',
        });
        for (const [theme, mode] of Object.entries(JELLYFIN_WEB_THEME_CONTRACT.builtInThemes)) {
            expect(officialJellyfinThemeMode(theme)).toBe(mode);
            expect(resolveTheme(themeConfiguration(), { ...baseMedia, jellyfinTheme: theme }).mode).toBe(mode);
        }
        expect(officialJellyfinThemeMode('future-theme')).toBeNull();
    });

    it('keeps the emitted --jf bridge exactly synchronized with the reviewed contract', () => {
        const css = serializeThemeStyles(resolveTheme(themeConfiguration(), baseMedia), 'committed');
        const emitted = [...new Set(
            [...css.matchAll(/^\s*(--jf-[\w-]+)\s*:/gm)].map((match) => match[1]),
        )].sort();
        const contracted = [...JELLYFIN_WEB_THEME_CONTRACT.bridgedVariables].sort();

        expect(emitted).toEqual(contracted);
        expect(css).toContain(':root.jc-modern-layout[data-jc-theme-active="true"]');
        expect(css).not.toContain('[data-theme=');
    });
});
