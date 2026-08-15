import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    applySubtitlePreviewStyle,
    clampSubtitleHorizontal,
    isFullyTransparentColor,
    resolveSubtitleStyle,
} from './subtitle-style-contract';

describe('subtitle playback and preview style contract', () => {
    beforeEach(() => {
        (globalThis as unknown as { CSS: unknown }).CSS = {
            supports: (property: string, value: string) => property === 'color'
                && /^(?:transparent|#[0-9a-f]{3,8}|(?:rgba?|hsla?|hwb|color)\(.+\))$/i.test(value),
        };
    });
    afterEach(() => {
        delete (globalThis as unknown as { CSS?: unknown }).CSS;
    });

    it('recognizes picker-shaped alpha-zero colors without hiding alpha-one colors', () => {
        for (const color of [
            'transparent', '#0000', '#F000', '#00000000', '#FF000000',
            'rgba(255,0,0,0)', 'hslA(12 50% 50% / 0%)',
            'rgb(255 0 0 / 0)', 'hsl(0 100% 50% / 0)',
            'color(srgb 1 0 0 / 0)', 'hwb(0 0% 0% / 0)',
        ]) {
            expect(isFullyTransparentColor(color), color).toBe(true);
        }
        for (const color of [
            '#FF000001', 'rgba(255,0,0,0.01)', '#000000FF',
            'rgb(255 0 0 / 0.001)', 'hsl(0 100% 50% / 1%)',
            'color(srgb 1 0 0 / 0.0001)', 'hwb(0 0% 0% / 0.1%)',
        ]) {
            expect(isFullyTransparentColor(color), color).toBe(false);
        }
    });

    it('keeps all six playback font presets distinct, readable, and ordered in the preview', () => {
        expect(Array.from({ length: 6 }, (_, selectedFontSizePresetIndex) => resolveSubtitleStyle({
            selectedFontSizePresetIndex,
        }).previewFontSizePx)).toEqual([8, 10, 12, 14, 16, 18]);
    });

    it.each([
        'rgb(255 0 0 / 0)',
        'hsl(0 100% 50% / 0)',
        'color(srgb 1 0 0 / 0)',
        'hwb(0 0% 0% / 0)',
    ])('removes the preview box and restores shadow for transparent %s', (background) => {
        const preview = document.createElement('div');
        applySubtitlePreviewStyle(preview, { customSubtitleBgColor: background });

        expect(resolveSubtitleStyle({ customSubtitleBgColor: background })).toMatchObject({
            visibleBackground: false,
            textShadow: '0 0 4px #000, 0 0 8px #000, 1px 1px 2px #000',
        });
        expect(preview.style.padding).toBe('0px');
        expect(preview.style.borderRadius).toBe('0px');
        expect(preview.style.textShadow).not.toBe('none');
    });

    it('resolves invalid colors and preset indices to safe bounded defaults', () => {
        const style = resolveSubtitleStyle({
            customSubtitleTextColor: 'red;background:url(https://invalid)',
            customSubtitleBgColor: 'not-a-color',
            selectedFontSizePresetIndex: 99,
            selectedFontFamilyPresetIndex: -1,
        });

        expect(style).toMatchObject({
            textColor: '#FFFFFFFF',
            backgroundColor: '#00000000',
            fontFamily: 'inherit',
            fontSizeVw: 1.2,
            previewFontSizePx: 12,
            visibleBackground: false,
        });
        expect(clampSubtitleHorizontal(null)).toBe(50);
        expect(clampSubtitleHorizontal('')).toBe(50);
    });

    it('applies font, colors, compact box, position clamps, and bottom anchoring together', () => {
        const preview = document.createElement('div');
        applySubtitlePreviewStyle(preview, {
            customSubtitleTextColor: '#FFFF00FF',
            customSubtitleBgColor: '#000000B2',
            selectedFontSizePresetIndex: 5,
            selectedFontFamilyPresetIndex: 3,
            subtitleHorizontalPosition: 100,
            subtitleVerticalPosition: -20,
        });

        expect(preview.style.color).toBe('rgb(255, 255, 0)');
        expect(preview.style.backgroundColor).toBe('rgba(0, 0, 0, 0.698)');
        expect(preview.style.fontFamily).toContain('Courier New');
        expect(preview.style.fontSize).toBe('18px');
        expect(preview.style.padding).toBe('0.08em 0.2em');
        expect(preview.style.borderRadius).toBe('0.15em');
        expect(preview.style.left).toBe(`${clampSubtitleHorizontal(100)}%`);
        expect(preview.style.top).toBe('2%');
        expect(preview.style.transform).toBe('translate(-50%, -100%)');
    });
});
