// src/enhanced/osd-pausescreen-surface.d.ts
// JEGlobal surface owned by the osd-rating / pausescreen modules (frozen public contract).
import type {} from '../types/jc';

declare module '../types/jc' {
    interface JEGlobal {
        // enhanced/osd-rating
        initializeOsdRating?: () => void;

        // enhanced/pausescreen
        initializePauseScreen?: () => void;
    }
}
