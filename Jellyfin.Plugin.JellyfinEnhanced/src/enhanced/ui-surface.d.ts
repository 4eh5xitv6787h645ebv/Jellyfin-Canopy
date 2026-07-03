// src/enhanced/ui-surface.d.ts
//
// JEGlobal surface owned by the ui-* modules (frozen public contract):
// consumed by js/plugin.js, other legacy areas and user scripts.

import type {} from '../types/je';

declare module '../types/je' {
    interface JEGlobal {
        /** ui-styles: injects the plugin's global CSS once. */
        injectGlobalStyles?: () => void;
        /** ui-entry-points: true when on the video player page. */
        isVideoPage?: () => boolean;
        /** ui-entry-points: true when on an item details page. */
        isDetailsPage?: () => boolean;
        /** ui-entry-points: adds the sidebar "Enhanced Panel" menu button. */
        addPluginMenuButton?: () => void;
        /** ui-entry-points: injects the settings button into the video OSD. */
        addOsdSettingsButton?: () => void;
        /** ui-entry-points: injects the link into the user-preferences menu. */
        addUserPreferencesLink?: () => void;
        /** ui-panel: opens/closes the main settings and help panel. */
        showEnhancedPanel?: () => Promise<void>;
    }
}
