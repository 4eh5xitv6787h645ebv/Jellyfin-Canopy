// src/enhanced/features/surface.d.ts
//
// JEGlobal surface owned by the features-* modules (frozen public contract):
// consumed by js/plugin.js, other legacy areas (e.g. events.js) and user scripts.

import type {} from '../../types/jc';

declare module '../../types/jc' {
    interface JEGlobal {
        /** features-random-button: injects the header Random button. */
        addRandomButton?: () => void;
        /** features-remove-home: which home surface a card belongs to. */
        detectCardSurface?: (el: unknown) => 'continuewatching' | 'nextup' | null;
        /** features-remove-home: hides emptied Continue Watching / Next Up rows. */
        hideEmptyHomeSections?: () => void;
        /** features-remove-home: injects Remove into the per-item action sheet. */
        addRemoveButton?: () => void;
        /** features-remove-multiselect: injects Remove into the multi-select menu. */
        addMultiSelectRemoveButton?: () => void;
    }
}
