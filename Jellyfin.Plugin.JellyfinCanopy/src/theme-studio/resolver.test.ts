import { describe, expect, it } from 'vitest';
import type { ThemeMediaState } from './resolver';
import { resolveBreakpoint, resolveTheme } from './resolver';
import { themeConfiguration } from '../test/theme-studio-fixture';
import { contrastRatio } from './color';
import { THEME_PALETTES, THEME_PRESETS } from './catalog';

function media(overrides: Partial<ThemeMediaState> = {}): ThemeMediaState {
    return {
        viewportWidth: 1280,
        viewportHeight: 800,
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

describe('Theme Studio resolver', () => {
    it('uses named phone, tablet, desktop, wide and TV scopes at exact boundaries', () => {
        expect(resolveBreakpoint(media({ viewportWidth: 390 }))).toBe('phone');
        expect(resolveBreakpoint(media({ viewportWidth: 599 }))).toBe('phone');
        expect(resolveBreakpoint(media({ viewportWidth: 600 }))).toBe('tablet');
        expect(resolveBreakpoint(media({ viewportWidth: 1023 }))).toBe('tablet');
        expect(resolveBreakpoint(media({ viewportWidth: 1024 }))).toBe('desktop');
        expect(resolveBreakpoint(media({ viewportWidth: 1599 }))).toBe('desktop');
        expect(resolveBreakpoint(media({ viewportWidth: 1600 }))).toBe('wide');
        expect(resolveBreakpoint(media({ viewportWidth: 390, tv: true }))).toBe('tv');
        expect(resolveBreakpoint(media({
            viewportWidth: 844, viewportHeight: 390, coarsePointer: true,
        }))).toBe('phone');
        expect(resolveBreakpoint(media({
            viewportWidth: 1024, viewportHeight: 768, coarsePointer: true,
        }))).toBe('tablet');
        expect(resolveBreakpoint(media({
            viewportWidth: 1366, viewportHeight: 768, coarsePointer: true,
        }))).toBe('desktop');
    });

    it('merges the active responsive scope after profile tokens', () => {
        const configuration = themeConfiguration();
        configuration.Profiles[0].Tokens = { 'space.page-gutter': 2, 'layout.navigation': 'header' };
        configuration.Profiles[0].Responsive.Phone = {
            Tokens: { 'space.page-gutter': 0.5, 'layout.navigation': 'bottom' },
        };
        const phone = resolveTheme(configuration, media({ viewportWidth: 390 }));
        const desktop = resolveTheme(configuration, media({ viewportWidth: 1440 }));
        expect(phone.tokens['space.page-gutter']).toBe(0.5);
        expect(phone.tokens['layout.navigation']).toBe('bottom');
        expect(desktop.tokens['space.page-gutter']).toBe(2);
        expect(desktop.tokens['layout.navigation']).toBe('header');
    });

    it('resolves every curated preset across phone, tablet, desktop and TV capability profiles', () => {
        for (const preset of THEME_PRESETS) {
            for (const state of [
                media({ viewportWidth: 390, viewportHeight: 844, coarsePointer: true, hover: false }),
                media({ viewportWidth: 820, viewportHeight: 1180, coarsePointer: true }),
                media({ viewportWidth: 1440, viewportHeight: 900 }),
                media({ viewportWidth: 1920, viewportHeight: 1080, tv: true, hover: false }),
            ]) {
                const configuration = themeConfiguration();
                configuration.Profiles[0].BasePreset = preset.id;
                configuration.Profiles[0].PresetVersion = 1;
                configuration.Profiles[0].FreezePresetVersion = true;
                const resolved = resolveTheme(configuration, state);
                expect(resolved, `${preset.id}/${resolved.breakpoint}`).toMatchObject({
                    preset: preset.id,
                    presetVersion: 1,
                    presetFallback: false,
                });
                expect(resolved.tokens['layout.navigation']).toBeDefined();
                expect(resolved.tokens['color.canvas']).toMatch(/^#[0-9A-F]{6}(?:[0-9A-F]{2})?$/i);
            }
        }
    });

    it('stores user choices as diffs after preset defaults and falls back safely for a missing frozen version', () => {
        const customized = themeConfiguration();
        customized.Profiles[0].BasePreset = 'glass';
        customized.Profiles[0].PresetVersion = 1;
        customized.Profiles[0].FreezePresetVersion = true;
        customized.Profiles[0].Tokens = { 'effects.blur': 7 };
        expect(resolveTheme(customized, media()).tokens).toMatchObject({
            'effects.material': 'glass',
            'effects.blur': 7,
        });

        customized.Profiles[0].PresetVersion = 2;
        expect(resolveTheme(customized, media())).toMatchObject({
            preset: 'canopy',
            presetVersion: 1,
            presetFallback: true,
        });
    });

    it('retains strong accessibility when a frozen preset version is unavailable', () => {
        const configuration = themeConfiguration();
        configuration.Profiles[0].BasePreset = 'high-contrast';
        configuration.Profiles[0].PresetVersion = 2;
        configuration.Profiles[0].FreezePresetVersion = true;

        const resolved = resolveTheme(configuration, media());
        expect(resolved).toMatchObject({
            preset: 'canopy',
            presetVersion: 1,
            presetFallback: true,
            highContrast: true,
            focus: 'strong',
        });
        expect(resolved.tokens).toMatchObject({
            'accessibility.contrast': 'on',
            'accessibility.focus-emphasis': 'strong',
            'elevation.focus-ring': 'strong',
        });
        expect(Number(resolved.tokens['shape.border-width'])).toBeGreaterThanOrEqual(2);
    });

    it('keeps palette character when the orthogonal accent uses the palette default', () => {
        const primaries = new Set<string>();
        for (const palette of THEME_PALETTES) {
            const configuration = themeConfiguration();
            configuration.Profiles[0].Palette = palette.id;
            configuration.Profiles[0].Accent = 'palette';
            const resolved = resolveTheme(configuration, media());
            expect(resolved.palette).toBe(palette.id);
            expect(resolved.tokens['color.primary']).toBe(palette.colors.dark['color.primary']);
            primaries.add(String(resolved.tokens['color.primary']));
        }
        expect(primaries.size).toBeGreaterThan(12);
    });

    it('follows Jellyfin data-theme for system mode without owning it', () => {
        const configuration = themeConfiguration();
        expect(resolveTheme(configuration, media({ jellyfinTheme: 'light', darkScheme: true })).mode).toBe('light');
        expect(resolveTheme(configuration, media({ jellyfinTheme: 'dark', darkScheme: false })).mode).toBe('dark');
        expect(resolveTheme(configuration, media({ jellyfinTheme: '', darkScheme: false })).mode).toBe('light');
    });

    it('can only reduce motion/transparency and strengthens focus for system contrast', () => {
        const configuration = themeConfiguration();
        configuration.Profiles[0].Accessibility.Motion = 'on';
        configuration.Profiles[0].Accessibility.Transparency = 'on';
        const resolved = resolveTheme(configuration, media({
            reducedMotion: true,
            reducedTransparency: true,
            moreContrast: true,
            hover: false,
            coarsePointer: true,
        }));
        expect(resolved).toMatchObject({
            reducedMotion: true,
            reducedTransparency: true,
            highContrast: true,
            focus: 'strong',
            coarsePointer: true,
        });
        expect(resolved.tokens).toMatchObject({
            'motion.profile': 'off',
            'motion.duration-scale': 0,
            'motion.hover-lift': 0,
            'effects.material': 'solid',
            'effects.blur': 0,
            'layout.card-actions': 'always',
        });
    });

    it('also reduces effects when the profile requests it without an OS preference', () => {
        const configuration = themeConfiguration();
        configuration.Profiles[0].Accessibility.Motion = 'off';
        configuration.Profiles[0].Accessibility.Transparency = 'off';
        const resolved = resolveTheme(configuration, media());
        expect(resolved).toMatchObject({ reducedMotion: true, reducedTransparency: true });
    });

    it('pairs every bundled accent with a WCAG-readable primary foreground', () => {
        for (const accent of [
            'violet', 'blue', 'cyan', 'teal', 'green', 'amber', 'orange', 'red', 'pink', 'neutral',
        ]) {
            for (const mode of ['dark', 'light'] as const) {
                const configuration = themeConfiguration();
                configuration.Profiles[0].Accent = accent;
                configuration.Profiles[0].Mode = mode;
                const resolved = resolveTheme(configuration, media());
                expect(contrastRatio(
                    String(resolved.tokens['color.on-primary']),
                    String(resolved.tokens['color.primary']),
                    String(resolved.tokens['color.surface']),
                    String(resolved.tokens['color.canvas']),
                ), `${accent}/${mode}`).toBeGreaterThanOrEqual(4.5);
            }
        }
    });

    it('corrects an unreadable custom primary foreground after alpha composition', () => {
        const configuration = themeConfiguration();
        configuration.Profiles[0].Tokens = {
            'color.primary': '#FFFFFF80',
            'color.on-primary': '#FFFFFF',
        };
        const resolved = resolveTheme(configuration, media({ jellyfinTheme: 'light' }));
        expect(resolved.tokens['color.on-primary']).toBe('#000000');
        expect(contrastRatio(
            String(resolved.tokens['color.on-primary']),
            String(resolved.tokens['color.primary']),
            String(resolved.tokens['color.surface']),
            String(resolved.tokens['color.canvas']),
        )).toBeGreaterThanOrEqual(4.5);
    });

    it('composites translucent custom surfaces over the canvas before choosing a foreground', () => {
        const configuration = themeConfiguration();
        configuration.Profiles[0].Tokens = {
            'color.canvas': '#FFFFFF',
            'color.surface': '#FFFFFF00',
            'color.primary': '#00000080',
            'color.on-primary': '#FFFFFF',
        };
        const resolved = resolveTheme(configuration, media());
        expect(resolved.tokens['color.on-primary']).toBe('#000000');
        expect(contrastRatio(
            String(resolved.tokens['color.on-primary']),
            String(resolved.tokens['color.primary']),
            String(resolved.tokens['color.surface']),
            String(resolved.tokens['color.canvas']),
        )).toBeGreaterThanOrEqual(4.5);
    });

    it('selects the highest-priority seasonal profile across a year boundary', () => {
        const configuration = themeConfiguration();
        configuration.Profiles.push({
            ...structuredClone(configuration.Profiles[0]),
            Id: 'winter',
            Name: 'Winter',
            BasePreset: 'oled',
        });
        configuration.Schedule = [{
            Id: 'winter-run',
            ProfileId: 'winter',
            StartMonthDay: '12-15',
            EndMonthDay: '01-10',
            Priority: 80,
            Enabled: true,
        }];
        expect(resolveTheme(configuration, media(), { now: new Date(2026, 0, 2) }).profileId).toBe('winter');
        expect(resolveTheme(configuration, media(), {
            now: new Date(2026, 0, 2), allowScheduling: false,
        }).profileId).toBe('default');
    });
});
