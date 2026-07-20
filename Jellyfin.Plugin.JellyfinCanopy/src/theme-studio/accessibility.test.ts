import { describe, expect, it } from 'vitest';
import { themeConfiguration } from '../test/theme-studio-fixture';
import {
    auditThemeContrast,
    serializeAccessibilityAdapters,
    THEME_CONTRAST_CONTRACT,
} from './accessibility';
import { THEME_ACCENTS, THEME_PALETTES, THEME_PRESETS } from './catalog';
import { contrastRatio, readableForegroundAgainst } from './color';
import { resolveTheme, type ThemeMediaState } from './resolver';

function media(overrides: Partial<ThemeMediaState> = {}): ThemeMediaState {
    return {
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
        ...overrides,
    };
}

function expectContract(theme: ReturnType<typeof resolveTheme>, label: string): void {
    const results = auditThemeContrast(theme.tokens);
    expect(results).toHaveLength(THEME_CONTRAST_CONTRACT.length);
    expect(results.filter((result) => !result.passes), label).toEqual([]);
}

describe('Theme Studio accessibility contract', () => {
    it('covers every required contrast purpose with final-composited ratios', () => {
        expect(new Set(THEME_CONTRAST_CONTRACT.map((entry) => entry.purpose))).toEqual(new Set([
            'text', 'icon', 'focus', 'control', 'status', 'disabled', 'scrim',
        ]));
        expect(THEME_CONTRAST_CONTRACT.some((entry) => entry.background === 'color.overlay')).toBe(true);
        expect(THEME_CONTRAST_CONTRACT.some((entry) => entry.foreground === 'color.on-scrim')).toBe(true);
    });

    it('enforces the complete matrix for every preset, palette, accent, mode and OLED state', () => {
        for (const preset of THEME_PRESETS) {
            for (const mode of ['dark', 'light'] as const) {
                const configuration = themeConfiguration();
                configuration.Profiles[0].BasePreset = preset.id;
                configuration.Profiles[0].Mode = mode;
                expectContract(
                    resolveTheme(configuration, media({ jellyfinTheme: mode })),
                    `${preset.id}/${mode}`,
                );
            }
        }
        for (const palette of THEME_PALETTES) {
            for (const mode of ['dark', 'light'] as const) {
                const configuration = themeConfiguration();
                const profile = configuration.Profiles[0];
                profile.Palette = palette.id;
                profile.Mode = mode;
                for (const accent of THEME_ACCENTS) {
                    profile.Accent = accent.id;
                    expectContract(
                        resolveTheme(configuration, media({ jellyfinTheme: mode })),
                        `${palette.id}/${accent.id}/${mode}`,
                    );
                }
            }
        }
    });

    it('repairs hostile translucent overrides without accepting an unbounded CSS value', () => {
        const configuration = themeConfiguration();
        configuration.Profiles[0].Tokens = {
            'color.canvas': '#000000',
            'color.surface': '#FFFFFF',
            'color.elevated': '#00000000',
            'color.overlay': '#FFFFFF80',
            'color.text': '#77777740',
            'color.text-muted': '#77777740',
            'color.primary': '#FFFFFF80',
            'color.on-primary': '#FFFFFF40',
            'color.secondary': '#77777780',
            'color.positive': '#77777740',
            'color.caution': '#77777740',
            'color.negative': '#77777740',
            'color.info': '#77777740',
            'color.divider': '#77777720',
            'color.focus': '#77777720',
        };
        const theme = resolveTheme(configuration, media());
        expectContract(theme, 'hostile overrides');
        expect(Object.values(theme.tokens).some((value) => String(value).includes('url('))).toBe(false);
    });

    it('falls back from transparent glass when artwork can make foregrounds unreadable', () => {
        const configuration = themeConfiguration();
        configuration.Profiles[0].Tokens = {
            'effects.level': 'full',
            'effects.material': 'glass',
            'effects.backdrop-opacity': 0,
            'color.canvas': '#10151C',
            'color.surface': '#111820',
            'color.elevated': '#18212C',
            'color.text': '#FFFFFF',
            'color.primary': '#FFFFFF',
        };
        const theme = resolveTheme(configuration, media({ backdropFilterSupported: true }));
        expect(theme.effectsMaterial).toBe('glass');
        expect(Number(theme.tokens['effects.backdrop-opacity'])).toBeGreaterThan(0);
        expectContract(theme, 'transparent glass fallback');
    });

    it('finds a bounded mid-tone focus color across opposite black and white surfaces', () => {
        const color = readableForegroundAgainst('#FFFFFF', [
            { background: '#000000', surface: '#000000', canvas: '#000000' },
            { background: '#FFFFFF', surface: '#FFFFFF', canvas: '#FFFFFF' },
        ], 3);
        expect(contrastRatio(color, '#000000')).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(color, '#FFFFFF')).toBeGreaterThanOrEqual(3);
    });

    it('maintains High Contrast as token behavior and a forced-colors adaptation', () => {
        const configuration = themeConfiguration();
        configuration.Profiles[0].BasePreset = 'high-contrast';
        const theme = resolveTheme(configuration, media({ moreContrast: true, forcedColors: true }));
        expect(theme).toMatchObject({ highContrast: true, forcedColors: true, focus: 'strong' });
        expect(theme.tokens).toMatchObject({
            'accessibility.underline-links': true,
            'effects.level': 'minimal',
            'effects.material': 'solid',
            'icon.multicolor-metadata': false,
        });
        expectContract(theme, 'high contrast');

        const css = serializeAccessibilityAdapters(':root.jc-modern-layout[data-jc-theme-active="true"]', theme);
        expect(css).toContain('@media (forced-colors: active)');
        expect(css).toContain('--jf-palette-primary-main: Highlight');
        expect(css).toContain('border: 3px double Highlight');
        expect(css).toContain('text-decoration: underline wavy');
        expect(css).toContain('text-decoration-line: underline');
    });

    it('serializes reduced preferences, non-color state cues, logical properties, and exact modern scopes', () => {
        const configuration = themeConfiguration();
        configuration.Profiles[0].Accessibility.Motion = 'off';
        configuration.Profiles[0].Accessibility.Transparency = 'off';
        const theme = resolveTheme(configuration, media({ coarsePointer: true, hover: false }));
        const css = serializeAccessibilityAdapters(':root.jc-modern-layout[data-jc-theme-active="true"]', theme);
        expect(css).toContain('animation-duration: 0.01ms !important');
        expect(css).toContain('@media (prefers-reduced-transparency: reduce)');
        expect(css).toContain('[data-jc-theme-pointer="coarse"]');
        expect(css).toContain('border-inline-start:');
        expect(css).toContain('[dir="rtl"] .jc-theme-directional-icon');
        expect(css).toContain('[data-jc-theme-breakpoint="phone"]');
        expect(css).toContain('[data-jc-theme-breakpoint="desktop"]');
        expect(css).toContain('[data-jc-theme-breakpoint="wide"]');
        expect(css).not.toContain('[data-jc-theme-breakpoint="tablet"]');
        expect(css).not.toContain('[data-jc-theme-breakpoint="tv"]');
        expect(css).not.toMatch(/\b(?:margin|padding|border|inset)-(?:left|right)\b/);
    });
});
