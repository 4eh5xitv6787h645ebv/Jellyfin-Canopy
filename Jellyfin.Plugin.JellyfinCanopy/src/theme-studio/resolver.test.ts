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

    it('resolves automatic presentation choices by capability without changing host structure', () => {
        const configuration = themeConfiguration();
        configuration.Profiles[0].Tokens = {
            'layout.navigation': 'auto',
            'layout.seasons': 'auto',
        };

        expect(resolveTheme(configuration, media({ viewportWidth: 390 })).presentation).toMatchObject({
            navigation: 'bottom', seasons: 'list',
        });
        expect(resolveTheme(configuration, media({ viewportWidth: 820 })).presentation).toMatchObject({
            navigation: 'pills', seasons: 'grid',
        });
        expect(resolveTheme(configuration, media({ viewportWidth: 1440 })).presentation).toMatchObject({
            navigation: 'header', seasons: 'grid',
        });
        expect(resolveTheme(configuration, media({ viewportWidth: 1920, tv: true })).presentation).toMatchObject({
            navigation: 'sidebar', seasons: 'grid',
        });
    });

    it('publishes every explicit shell module choice and makes no-hover card actions reachable', () => {
        const configuration = themeConfiguration();
        configuration.Profiles[0].Tokens = {
            'layout.density': 'spacious',
            'layout.navigation': 'sidebar',
            'layout.home-hero': 'cinematic',
            'layout.details': 'compact',
            'layout.seasons': 'list',
            'layout.card-actions': 'menu',
            'layout.poster-ratio': 'backdrop',
            'layout.cast-shape': 'rounded',
            'progress.position': 'floating',
            'progress.watched-indicator': 'floating',
            'progress.unwatched-indicator': 'none',
        };
        const fine = resolveTheme(configuration, media());
        expect(fine.presentation).toEqual({
            density: 'spacious',
            navigation: 'sidebar',
            homeHero: 'cinematic',
            details: 'compact',
            seasons: 'list',
            cardActions: 'menu',
            posterRatio: 'backdrop',
            castShape: 'rounded',
            progressPosition: 'floating',
            watchedIndicator: 'floating',
            unwatchedIndicator: 'none',
        });

        const touch = resolveTheme(configuration, media({ hover: false, coarsePointer: true }));
        expect(touch.presentation.cardActions).toBe('always');
    });

    it('maps a persisted unwatched check value to the safe numeric corner badge', () => {
        const configuration = themeConfiguration();
        configuration.Profiles[0].Tokens = { 'progress.unwatched-indicator': 'check' };

        expect(resolveTheme(configuration, media()).presentation.unwatchedIndicator).toBe('corner');
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

    it('keeps distinct palette character while repairing the palette-default accent', () => {
        const primaries = new Set<string>();
        for (const palette of THEME_PALETTES) {
            const configuration = themeConfiguration();
            configuration.Profiles[0].Palette = palette.id;
            configuration.Profiles[0].Accent = 'palette';
            const resolved = resolveTheme(configuration, media());
            expect(resolved.palette).toBe(palette.id);
            expect(resolved.tokens['color.primary']).toMatch(/^#[0-9A-F]{6}$/i);
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
        configuration.Profiles[0].Tokens = {
            'player.control-material': 'glass',
            'player.pause-screen-material': 'glass',
            'player.subtitle-backdrop': 'box',
        };
        const resolved = resolveTheme(configuration, media());
        expect(resolved).toMatchObject({ reducedMotion: true, reducedTransparency: true });
        expect(resolved.tokens).toMatchObject({
            'player.control-material': 'solid',
            'player.pause-screen-material': 'solid',
            'player.subtitle-backdrop': 'solid',
        });
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

    it('applies monotonic administrator, capability, accessibility and low-power effects reductions', () => {
        const configuration = themeConfiguration();
        configuration.Profiles[0].Tokens = {
            'effects.level': 'full',
            'effects.material': 'glass',
            'effects.blur': 32,
            'effects.saturation': 2,
            'effects.backdrop-opacity': 0.55,
            'effects.glow': 1,
            'effects.image-treatment': 'blur',
            'elevation.card-shadow': 'strong',
            'elevation.dialog-shadow': 'strong',
            'motion.profile': 'expressive',
            'motion.duration-scale': 2,
            'motion.hover-lift': 12,
            'motion.page-transition': true,
            'motion.stagger': true,
            'color.dynamic-source': 'poster',
            'color.dynamic-strength': 0.75,
            'player.control-material': 'glass',
            'player.pause-screen-material': 'glass',
        };

        const full = resolveTheme(configuration, media({ backdropFilterSupported: true }), {
            maximumEffectsLevel: 'full',
        });
        expect(full).toMatchObject({
            effectsLevel: 'full', effectsMaterial: 'glass', imageTreatment: 'blur',
            motionProfile: 'expressive', dynamicColorSource: 'poster', dynamicColorStrength: 0.75,
        });

        const balanced = resolveTheme(configuration, media({ backdropFilterSupported: true }), {
            maximumEffectsLevel: 'balanced',
        });
        expect(balanced).toMatchObject({
            effectsLevel: 'balanced', effectsMaterial: 'glass', imageTreatment: 'gradient',
            motionProfile: 'calm', dynamicColorSource: 'poster',
        });
        expect(balanced.tokens).toMatchObject({
            'effects.blur': 12,
            'effects.saturation': 1.2,
            'effects.backdrop-opacity': 0.78,
            'effects.glow': 0.25,
            'elevation.card-shadow': 'soft',
            'elevation.dialog-shadow': 'medium',
            'motion.duration-scale': 1,
            'motion.hover-lift': 3,
            'motion.stagger': false,
        });

        for (const [label, resolved] of [
            ['administrator', resolveTheme(configuration, media(), { maximumEffectsLevel: 'minimal' })],
            ['malformed-admin', resolveTheme(configuration, media(), { maximumEffectsLevel: 'unbounded' })],
            ['low-power', resolveTheme(configuration, media({ lowPower: true }))],
            ['forced-colors', resolveTheme(configuration, media({ forcedColors: true }))],
            ['high-contrast', resolveTheme(configuration, media({ moreContrast: true }))],
        ] as const) {
            expect(resolved, label).toMatchObject({
                effectsLevel: 'minimal', effectsMaterial: 'solid', imageTreatment: 'none',
                motionProfile: 'off', dynamicColorSource: 'off',
            });
            expect(resolved.tokens, label).toMatchObject({
                'effects.blur': 0,
                'effects.glow': 0,
                'elevation.card-shadow': 'none',
                'motion.duration-scale': 0,
                'player.control-material': 'solid',
                'player.pause-screen-material': 'solid',
                'player.subtitle-backdrop': 'solid',
            });
        }

        const unsupported = resolveTheme(configuration, media({ backdropFilterSupported: false }));
        expect(unsupported).toMatchObject({ effectsLevel: 'balanced', effectsMaterial: 'translucent' });
        expect(unsupported.tokens).toMatchObject({ 'effects.blur': 0, 'effects.saturation': 1 });

        const privatePolicy = resolveTheme(configuration, media(), { allowDynamicColor: false });
        expect(privatePolicy.dynamicColorSource).toBe('off');

        configuration.Profiles[0].Tokens['effects.level'] = 'minimal';
        expect(resolveTheme(configuration, media(), { maximumEffectsLevel: 'full' }).effectsLevel).toBe('minimal');
    });

    it('preserves the valid zero saturation boundary when Balanced caps only the maximum', () => {
        const configuration = themeConfiguration();
        configuration.Profiles[0].Tokens = {
            'effects.level': 'full',
            'effects.saturation': 0,
        };
        expect(resolveTheme(configuration, media(), { maximumEffectsLevel: 'balanced' })
            .tokens['effects.saturation']).toBe(0);
    });

    it('publishes deterministic holiday schedule metadata and honors UTC policy', () => {
        const configuration = themeConfiguration();
        configuration.ScheduleTimeZone = 'utc';
        configuration.Profiles.push({
            ...structuredClone(configuration.Profiles[0]), Id: 'seasonal', Name: 'Seasonal',
        }, {
            ...structuredClone(configuration.Profiles[0]), Id: 'holiday', Name: 'Holiday',
        });
        configuration.Schedule = [
            { Id: 'winter', ProfileId: 'seasonal', Kind: 'season', StartMonthDay: '12-01', EndMonthDay: '02-28', Priority: 100, Enabled: true },
            { Id: 'new-year', ProfileId: 'holiday', Kind: 'holiday', StartMonthDay: '01-01', EndMonthDay: '01-01', Priority: 0, Enabled: true },
        ];
        expect(resolveTheme(configuration, media(), { now: new Date('2027-01-01T00:30:00Z') })).toMatchObject({
            profileId: 'holiday', scheduleId: 'new-year', scheduleKind: 'holiday', scheduleTimeZone: 'utc',
        });
    });
});
