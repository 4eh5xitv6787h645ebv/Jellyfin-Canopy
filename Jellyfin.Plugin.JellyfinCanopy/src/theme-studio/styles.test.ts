import { describe, expect, it } from 'vitest';
import { resolveTheme, type ThemeMediaState } from './resolver';
import { serializeThemeStyles } from './styles';
import { themeConfiguration } from '../test/theme-studio-fixture';

const media: ThemeMediaState = {
    viewportWidth: 390,
    viewportHeight: 844,
    tv: false,
    darkScheme: true,
    reducedMotion: false,
    moreContrast: false,
    reducedTransparency: false,
    forcedColors: false,
    hover: false,
    coarsePointer: true,
    jellyfinTheme: 'dark',
};

describe('Theme Studio CSS serialization', () => {
    it('is deterministic and bridges stable Canopy tokens to pinned Jellyfin roles', () => {
        const theme = resolveTheme(themeConfiguration(), media);
        const first = serializeThemeStyles(theme, 'committed');
        expect(serializeThemeStyles(theme, 'committed')).toBe(first);
        for (const role of [
            '--jc-color-canvas',
            '--jc-safe-area-bottom',
            '--jf-palette-background-default',
            '--jf-palette-background-paper',
            '--jf-palette-text-primary',
            '--jf-palette-primary-main',
            '--jf-palette-primary-mainChannel',
            '--jf-palette-action-selectedOpacity',
            '--jf-palette-AppBar-defaultBg',
            '--jf-card-borderRadius',
        ]) expect(first, role).toContain(`${role}:`);
        expect(first).toContain(':root[data-jc-theme-active="true"]');
        expect(first).not.toContain('@layer');
        expect(first).toContain('Adapter legacy-v12-base-surfaces');
        expect(first).toContain('.jc-legacy-layout[data-jc-theme-route]');
        expect(first).toContain('Adapter focus-v12');
        expect(first).toContain('--jf-palette-error-contrastText: #000000');
        expect(first).not.toContain('url(');
        expect(first).not.toContain('@import');
    });

    it('keeps preview in the later cascade layer and emits bounded accessibility adapters', () => {
        const configuration = themeConfiguration();
        configuration.Profiles[0].Accessibility.Motion = 'off';
        configuration.Profiles[0].Accessibility.UnderlineLinks = true;
        const theme = resolveTheme(configuration, { ...media, forcedColors: true });
        const css = serializeThemeStyles(theme, 'preview');
        expect(css).toContain(':root[data-jc-theme-preview="true"]');
        expect(css).toContain('animation-duration: 0.01ms !important');
        expect(css).toContain('text-decoration: underline');
        expect(css).toContain('@media (forced-colors: active)');
        expect(css).toContain('--jf-palette-primary-main: Highlight');
    });

    it('keeps a readable white error foreground for the darker light-mode negative color', () => {
        const theme = resolveTheme(themeConfiguration(), { ...media, jellyfinTheme: 'light' });
        expect(serializeThemeStyles(theme, 'committed'))
            .toContain('--jf-palette-error-contrastText: #FFFFFF');
    });
});
