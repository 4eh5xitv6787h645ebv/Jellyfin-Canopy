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
            '--jc-visual-viewport-height',
            '--jc-keyboard-inset',
            '--jc-effective-font-size',
            '--jc-content-max-inline-size',
            '--jc-motion-easing',
            '--jf-palette-background-default',
            '--jf-palette-background-paper',
            '--jf-palette-text-primary',
            '--jf-palette-primary-main',
            '--jf-palette-primary-mainChannel',
            '--jf-palette-action-selectedOpacity',
            '--jf-palette-AppBar-defaultBg',
            '--jf-card-borderRadius',
        ]) expect(first, role).toContain(`${role}:`);
        expect(first).toContain(':root.jc-modern-layout[data-jc-theme-active="true"]');
        expect(first).toContain(':not([data-jc-theme-preview="true"])');
        expect(first).not.toContain('@layer');
        expect(first).not.toContain('legacy-v12-base-surfaces');
        expect(first).not.toContain('.jc-legacy-layout');
        expect(first).not.toContain('.skinHeader');
        expect(first).toContain('Adapter focus-v12');
        for (const adapter of [
            'Adapter shell-navigation-v12',
            'Adapter home-hero-v12',
            'Adapter media-cards-v12',
            'Adapter details-cast-v12',
            'Adapter seasons-v12',
            'Adapter progress-indicators-v12',
            'Adapter dialogs-forms-v12',
            'Adapter player-media-v12',
            'Adapter music-now-playing-v12',
            'Adapter live-guide-v12',
            'Adapter book-reader-v12',
            'Adapter mobile-safe-area-v12',
            'Adapter canopy-shell-v1',
            'Adapter canopy-protection-v1',
            'Adapter canopy-card-overlays-v1',
            'Adapter canopy-transient-ui-v1',
        ]) expect(first, adapter).toContain(adapter);
        expect(first).toContain('[data-jc-theme-navigation="bottom"]');
        expect(first).toContain('[data-jc-theme-home-hero="cinematic"]');
        expect(first).toContain('[data-jc-theme-details="compact"]');
        expect(first).toContain('[data-jc-theme-seasons="list"]');
        expect(first).toContain('[data-jc-theme-poster-ratio="backdrop"]');
        expect(first).toContain('[data-jc-theme-progress-position="floating"]');
        expect(first).toContain(':not([data-jc-theme-route="dashboard"])');
        expect(first).toContain(`--jf-palette-error-contrastText: ${String(theme.tokens['color.on-negative'])}`);
        expect(first).not.toContain('url(');
        expect(first).not.toContain('@import');
        expect(first).not.toMatch(/(?:^|[;{\n])\s*order\s*:/m);
    });

    it('keeps preview in the later cascade layer and emits bounded accessibility adapters', () => {
        const configuration = themeConfiguration();
        configuration.Profiles[0].Accessibility.Motion = 'off';
        configuration.Profiles[0].Accessibility.UnderlineLinks = true;
        const theme = resolveTheme(configuration, { ...media, forcedColors: true });
        const css = serializeThemeStyles(theme, 'preview');
        expect(css).toContain(':root.jc-modern-layout[data-jc-theme-preview="true"]');
        expect(css).toContain('animation-duration: 0.01ms !important');
        expect(css).toContain('text-decoration: underline');
        expect(css).toContain('@media (forced-colors: active)');
        expect(css).toContain('--jf-palette-primary-main: Highlight');
        expect(css).not.toContain(':not([data-jc-theme-preview="true"])');
    });

    it('bridges the enforced light-mode error foreground', () => {
        const theme = resolveTheme(themeConfiguration(), { ...media, jellyfinTheme: 'light' });
        expect(serializeThemeStyles(theme, 'committed'))
            .toContain(`--jf-palette-error-contrastText: ${String(theme.tokens['color.on-negative'])}`);
    });

    it('composites translucent error surfaces over the canvas before choosing its foreground', () => {
        const configuration = themeConfiguration();
        configuration.Profiles[0].Tokens = {
            'color.canvas': '#FFFFFF',
            'color.surface': '#FFFFFF00',
            'color.negative': '#00000080',
        };
        const theme = resolveTheme(configuration, media);
        expect(serializeThemeStyles(theme, 'committed'))
            .toContain(`--jf-palette-error-contrastText: ${String(theme.tokens['color.on-negative'])}`);
    });

    it('precomputes density and text scaling into valid bounded dimensions', () => {
        const configuration = themeConfiguration();
        configuration.Profiles[0].Tokens = {
            'layout.density': 'spacious',
            'space.scale': 'compact',
            'space.page-gutter': 2,
            'type.scale': 1.25,
            'accessibility.text-scale': 1.2,
        };
        const css = serializeThemeStyles(resolveTheme(configuration, media), 'committed');
        expect(css).toContain('--jc-density-factor: 1.18');
        expect(css).toContain('--jc-space-factor: 0.875');
        expect(css).toContain('--jc-page-gutter: 2.065rem');
        expect(css).toContain('--jc-effective-font-size: 1.5rem');
    });
});
