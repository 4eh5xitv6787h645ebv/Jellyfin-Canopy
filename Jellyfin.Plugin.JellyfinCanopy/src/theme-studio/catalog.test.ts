import { describe, expect, it } from 'vitest';
import {
    JELLYFISH_PALETTE_IDS,
    resolveAccent,
    resolvePalette,
    resolvePresetVersion,
    THEME_ACCENTS,
    THEME_ICON_FAMILIES,
    THEME_PALETTES,
    THEME_PRESETS,
    THEME_PROVENANCE,
    THEME_SURFACE_COVERAGE,
} from './catalog';
import { contrastRatio, readableForeground } from './color';
import { THEME_TOKEN_RULES } from './schema';

function expectTokenMap(tokens: Readonly<Record<string, unknown>>): void {
    for (const [name, value] of Object.entries(tokens)) {
        expect(THEME_TOKEN_RULES.get(name), `declared token ${name}`).toBeTypeOf('function');
        expect(THEME_TOKEN_RULES.get(name)?.(value), `${name}=${String(value)}`).toBe(true);
    }
}

describe('Theme Studio curated catalog', () => {
    it('ships immutable, versioned, schema-valid presets with complete declared coverage', () => {
        expect(THEME_PRESETS.map((preset) => preset.id)).toEqual([
            'canopy', 'minimal', 'cinematic', 'glass', 'material', 'studio',
            'tv-focus', 'oled', 'high-contrast',
        ]);
        const captureIds = new Set<string>();
        for (const preset of THEME_PRESETS) {
            expect(Object.isFrozen(preset), preset.id).toBe(true);
            expect(preset.version).toBe(1);
            expect(preset.modes).toEqual(['system', 'dark', 'light']);
            expect(preset.surfaceCoverage).toEqual(THEME_SURFACE_COVERAGE);
            expect(preset.description.length).toBeGreaterThan(20);
            expect(preset.provenance.length).toBeGreaterThan(0);
            expect(preset.thumbnail.kind).toBe('verified-live-capture');
            expect(captureIds.has(preset.thumbnail.captureId), preset.thumbnail.captureId).toBe(false);
            captureIds.add(preset.thumbnail.captureId);
            expectTokenMap(preset.tokens);
            for (const tokens of Object.values(preset.modeTokens)) expectTokenMap(tokens ?? {});
            for (const tokens of Object.values(preset.responsive)) expectTokenMap(tokens ?? {});
        }
        expect(() => (THEME_PRESETS as unknown as ThemePresetMutation)[0].name = 'mutated').toThrow();
    });

    it('uses latest versions by default and fails a missing frozen version to Canopy', () => {
        expect(resolvePresetVersion('glass', null, false)).toMatchObject({
            fallback: false, definition: { id: 'glass', version: 1 },
        });
        expect(resolvePresetVersion('glass', 1, true)).toMatchObject({
            fallback: false, definition: { id: 'glass', version: 1 },
        });
        expect(resolvePresetVersion('glass', 2, true)).toMatchObject({
            fallback: true, definition: { id: 'canopy', version: 1 },
        });
        expect(resolvePresetVersion('unknown', null, false)).toMatchObject({
            fallback: true, definition: { id: 'canopy', version: 1 },
        });
    });

    it('passes final-composited palette, semantic, focus and accent contrast checks', () => {
        for (const palette of THEME_PALETTES) {
            expect(Object.isFrozen(palette), palette.id).toBe(true);
            expect(palette.modes).toEqual(['system', 'dark', 'light']);
            for (const mode of ['dark', 'light'] as const) {
                const colors = palette.colors[mode];
                expectTokenMap(colors);
                const canvas = String(colors['color.canvas']);
                const surface = String(colors['color.surface']);
                expect(contrastRatio(String(colors['color.text']), canvas, canvas, canvas),
                    `${palette.id}/${mode} canvas text`).toBeGreaterThanOrEqual(4.5);
                expect(contrastRatio(String(colors['color.text']), surface, canvas, canvas),
                    `${palette.id}/${mode} surface text`).toBeGreaterThanOrEqual(4.5);
                expect(contrastRatio(String(colors['color.text-muted']), surface, canvas, canvas),
                    `${palette.id}/${mode} muted text`).toBeGreaterThanOrEqual(4.5);
                expect(contrastRatio(String(colors['color.focus']), canvas, canvas, canvas),
                    `${palette.id}/${mode} focus`).toBeGreaterThanOrEqual(3);

                for (const accent of THEME_ACCENTS) {
                    const primary = resolveAccent(accent.id, mode) ?? String(colors['color.primary']);
                    const foreground = readableForeground(
                        primary,
                        String(colors['color.on-primary']),
                        surface,
                        canvas,
                    );
                    expect(contrastRatio(foreground, primary, surface, canvas),
                        `${palette.id}/${accent.id}/${mode}`).toBeGreaterThanOrEqual(4.5);
                }

                const negative = String(colors['color.negative']);
                const onNegative = readableForeground(negative, '#FFFFFF', surface, canvas);
                expect(contrastRatio(onNegative, negative, surface, canvas),
                    `${palette.id}/${mode} error`).toBeGreaterThanOrEqual(4.5);
            }
        }
        expect(resolvePalette('not-real').id).toBe('canopy-night');
    });

    it('covers every legacy Jellyfish name with Canopy-authored semantic data', () => {
        expect(Object.keys(JELLYFISH_PALETTE_IDS)).toEqual([
            'Aurora', 'Banana', 'Coal', 'Coral', 'Forest', 'Grass', 'Jellyblue', 'Jellyflix',
            'Jellypurple', 'Lavender', 'Midnight', 'Mint', 'Ocean', 'Peach', 'Watermelon',
        ]);
        for (const paletteId of Object.values(JELLYFISH_PALETTE_IDS)) {
            expect(resolvePalette(paletteId).id).toBe(paletteId);
        }
    });

    it('has a complete machine-readable license/provenance graph and local icon contract', () => {
        expect(THEME_PROVENANCE.schemaVersion).toBe(1);
        expect(THEME_PROVENANCE.sources.length).toBeGreaterThan(15);
        const sources = new Map(THEME_PROVENANCE.sources.map((source) => [source.id, source]));
        const catalogItems = new Map<string, readonly string[]>([
            ...THEME_PRESETS.map((preset) => [`preset:${preset.id}`, preset.provenance] as const),
            ...THEME_PALETTES.map((palette) => [`palette:${palette.id}`, palette.provenance] as const),
            ...THEME_ICON_FAMILIES.map((icon) => [`icon:${icon.id}`, icon.provenance] as const),
        ]);
        for (const [item, provenance] of catalogItems) {
            for (const sourceId of provenance) {
                const source = sources.get(sourceId);
                expect(source, `${item} source ${sourceId}`).toBeDefined();
                expect(source?.usedBy, `${sourceId} reverse link`).toContain(item);
            }
        }
        for (const source of THEME_PROVENANCE.sources) {
            expect(source.url).toMatch(/^https:\/\/github\.com\//);
            expect(source.license.length).toBeGreaterThan(2);
            expect(source.reuse.length).toBeGreaterThan(4);
            for (const item of source.usedBy) expect(catalogItems.has(item), item).toBe(true);
        }
        for (const icon of THEME_ICON_FAMILIES) {
            expect(icon).toMatchObject({
                local: true,
                semanticColor: 'currentColor',
                labelsRequired: true,
                statusRequiresTextOrColor: true,
            });
        }
    });
});

type ThemePresetMutation = Array<{ name: string }>;
