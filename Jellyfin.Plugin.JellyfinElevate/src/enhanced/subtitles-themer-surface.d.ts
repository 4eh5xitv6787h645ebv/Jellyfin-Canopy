// src/enhanced/subtitles-themer-surface.d.ts
// JEGlobal surface owned by the subtitles/themer modules (frozen public contract).
//
// NOTE: JE.themer itself is already declared in src/types/je.ts (core reads
// getThemeVariables), so it is NOT re-declared here — interface merging forbids
// re-declaring the same property. Only the subtitles-owned members are added.
import type {} from '../types/je';

declare module '../types/je' {
    interface SubtitlePreset {
        name: string;
        textColor: string;
        bgColor: string;
        textShadow?: string;
        previewText: string;
    }

    interface FontSizePreset {
        name: string;
        size: number;
        previewText: string;
    }

    interface FontFamilyPreset {
        name: string;
        family: string;
        previewText: string;
    }

    interface JEGlobal {
        // enhanced/subtitles
        subtitlePresets?: SubtitlePreset[];
        fontSizePresets?: FontSizePreset[];
        fontFamilyPresets?: FontFamilyPreset[];
        applySubtitlePosition?: () => void;
        applySubtitleStyles?: (
            textColor: string,
            bgColor: string,
            fontSize: number,
            fontFamily: string,
            textShadow: string
        ) => void;
        applySavedStylesWhenReady?: () => void;
    }
}
