// src/enhanced/hidden-content-page/surface.d.ts
//
// JEGlobal surface owned by the hidden-content-page-* modules (frozen public
// contract): JC.hiddenContentPage.renderForCustomTab is called by the
// PluginPages HTML + the custom-tab module; JC.initializeHiddenContentPage is
// invoked by js/plugin.js.

import type {} from '../../types/jc';

declare module '../../types/jc' {
    interface HiddenContentPageApi {
        initialize(): void;
        showPage(): void;
        hidePage(): void;
        renderPage(targetContainer?: HTMLElement): void;
        renderForCustomTab(targetContainer?: HTMLElement): void;
        injectStyles(): void;
    }

    interface JEGlobal {
        hiddenContentPage?: HiddenContentPageApi;
        initializeHiddenContentPage?: () => void;
        /** Pre-fetched host user (jellyfin-web), read for the admin gate. */
        currentUser?: { Policy?: { IsAdministrator?: boolean }; [key: string]: unknown };
    }
}
