import { cssColorOr } from '../core/css-safe';
import { fontFamilyPresets, fontSizePresets } from './subtitle-presets';

export const SUBTITLE_HORIZONTAL_MIN = 10;
export const SUBTITLE_HORIZONTAL_MAX = 90;
export const SUBTITLE_VERTICAL_MIN = 2;
export const SUBTITLE_VERTICAL_MAX = 98;

export interface ResolvedSubtitleStyle {
    backgroundColor: string;
    fontFamily: string;
    fontSizeVw: number;
    previewFontSizePx: number;
    textColor: string;
    textShadow: string;
    visibleBackground: boolean;
}

type SubtitleSettings = Readonly<Record<string, unknown>>;

function clamp(value: unknown, fallback: number, minimum: number, maximum: number): number {
    const number = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : Number.NaN;
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

export function clampSubtitleHorizontal(value: unknown): number {
    return clamp(value, 50, SUBTITLE_HORIZONTAL_MIN, SUBTITLE_HORIZONTAL_MAX);
}

export function clampSubtitleVertical(value: unknown): number {
    return clamp(value, 85, SUBTITLE_VERTICAL_MIN, SUBTITLE_VERTICAL_MAX);
}

/** True for every alpha-zero serialization emitted by the subtitle picker. */
export function isFullyTransparentColor(value: string | undefined): boolean {
    const normalized = value?.replace(/\s+/g, '').toLowerCase();
    if (!normalized) return false;
    if (normalized === 'transparent') return true;
    if (/^#[0-9a-f]{3}0$/.test(normalized) || /^#[0-9a-f]{6}00$/.test(normalized)) return true;
    const functional = normalized.match(/^(?:rgba|hsla)\((.*)\)$/);
    if (!functional) return false;
    const alpha = functional[1].match(/(?:,|\/)([+-]?(?:\d+\.?\d*|\.\d+)%?)$/)?.[1];
    if (!alpha) return false;
    const numeric = Number.parseFloat(alpha);
    return Number.isFinite(numeric) && numeric === 0;
}

function presetIndex(value: unknown, length: number, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < length
        ? value
        : fallback;
}

/** Resolve the single validated style contract shared by playback and its preview. */
export function resolveSubtitleStyle(settings: SubtitleSettings): ResolvedSubtitleStyle {
    const textColor = cssColorOr(settings.customSubtitleTextColor, '#FFFFFFFF');
    const backgroundColor = cssColorOr(settings.customSubtitleBgColor, '#00000000');
    const size = fontSizePresets[presetIndex(settings.selectedFontSizePresetIndex, fontSizePresets.length, 2)];
    const family = fontFamilyPresets[presetIndex(settings.selectedFontFamilyPresetIndex, fontFamilyPresets.length, 0)];
    const visibleBackground = !isFullyTransparentColor(backgroundColor);
    return {
        backgroundColor,
        fontFamily: family.family,
        fontSizeVw: size.size,
        previewFontSizePx: Math.max(8, Math.min(18, Math.round(size.size * 6))),
        textColor,
        textShadow: visibleBackground ? 'none' : '0 0 4px #000, 0 0 8px #000, 1px 1px 2px #000',
        visibleBackground,
    };
}

/** Apply the validated playback-equivalent visual contract to one panel preview. */
export function applySubtitlePreviewStyle(
    preview: HTMLElement,
    settings: SubtitleSettings,
): void {
    const style = resolveSubtitleStyle(settings);
    preview.style.color = style.textColor;
    preview.style.backgroundColor = style.backgroundColor;
    preview.style.fontFamily = style.fontFamily;
    preview.style.fontSize = `${style.previewFontSizePx}px`;
    preview.style.textShadow = style.textShadow;
    preview.style.padding = style.visibleBackground ? '0.08em 0.2em' : '0';
    preview.style.borderRadius = style.visibleBackground ? '0.15em' : '0';
    preview.style.left = `${clampSubtitleHorizontal(settings.subtitleHorizontalPosition)}%`;
    preview.style.top = `${clampSubtitleVertical(settings.subtitleVerticalPosition)}%`;
    preview.style.transform = 'translate(-50%, -100%)';
}
