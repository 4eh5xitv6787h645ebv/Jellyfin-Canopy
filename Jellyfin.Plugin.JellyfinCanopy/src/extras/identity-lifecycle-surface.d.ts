// JEGlobal surface owned by the identity-aware extras modules.
import type {} from '../types/jc';

declare module '../types/jc' {
    interface JEGlobal {
        initializeColoredRatings?: () => void;
        pauseRatingsPolling?: () => void;
        resumeRatingsPolling?: () => void;
        initializeThemeSelector?: () => void;
    }
}
