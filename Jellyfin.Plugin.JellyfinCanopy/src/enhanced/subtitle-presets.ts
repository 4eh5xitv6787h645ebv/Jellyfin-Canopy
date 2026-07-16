import { JC } from '../globals';
import type { FontFamilyPreset, FontSizePreset, SubtitlePreset } from '../types/jc';

/** Boot-safe preset data required by the settings panel without the video engine. */
export const subtitlePresets: SubtitlePreset[] = [
    { name: 'Clean White', textColor: '#FFFFFFFF', bgColor: 'transparent', textShadow: '0 0 4px #000, 0 0 8px #000, 1px 1px 2px #000', previewText: 'Aa' },
    { name: 'Classic Black Box', textColor: '#FFFFFFFF', bgColor: '#000000FF', previewText: 'Aa' },
    { name: 'Netflix Style', textColor: '#FFFFFFFF', bgColor: '#000000B2', previewText: 'Aa' },
    { name: 'Cinema Yellow', textColor: '#FFFF00FF', bgColor: '#000000B2', previewText: 'Aa' },
    { name: 'Soft Gray', textColor: '#FFFFFFFF', bgColor: '#444444B2', previewText: 'Aa' },
    { name: 'High Contrast', textColor: '#000000FF', bgColor: '#FFFFFFFF', previewText: 'Aa' },
];

export const fontSizePresets: FontSizePreset[] = [
    { name: 'Tiny', size: 0.8, previewText: 'Aa' },
    { name: 'Small', size: 1, previewText: 'Aa' },
    { name: 'Normal', size: 1.2, previewText: 'Aa' },
    { name: 'Large', size: 1.8, previewText: 'Aa' },
    { name: 'Extra Large', size: 2, previewText: 'Aa' },
    { name: 'Gigantic', size: 3, previewText: 'Aa' },
];

export const fontFamilyPresets: FontFamilyPreset[] = [
    { name: 'Default', family: 'inherit', previewText: 'AaBb' },
    { name: 'Noto Sans', family: 'Noto Sans,sans-serif', previewText: 'AaBb' },
    { name: 'Sans Serif', family: 'Arial,Helvetica,sans-serif', previewText: 'AaBb' },
    { name: 'Typewriter', family: 'Courier New,Courier,monospace', previewText: 'AaBb' },
    { name: 'Roboto', family: 'Roboto Mono,monospace', previewText: 'AaBb' },
];

/** Publish inert preset data for the boot/settings surface. */
export function publishSubtitlePresets(): void {
    JC.subtitlePresets = subtitlePresets;
    JC.fontSizePresets = fontSizePresets;
    JC.fontFamilyPresets = fontFamilyPresets;
}
