// src/enhanced/osd-pausescreen-surface.d.ts
// JEGlobal surface owned by the osd-rating / pausescreen modules (frozen public contract).
import type {} from '../types/je';

declare module '../types/je' {
    interface JEGlobal {
        // enhanced/osd-rating
        initializeOsdRating?: () => void;

        // enhanced/pausescreen
        initializePauseScreen?: () => void;
    }
}
