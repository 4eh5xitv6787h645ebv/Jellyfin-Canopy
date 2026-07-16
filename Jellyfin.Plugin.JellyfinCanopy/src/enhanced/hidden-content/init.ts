// src/enhanced/hidden-content/init.ts
//
// Hidden Content — initialization: wires the modules together and
// exposes the frozen JC.initializeHiddenContent / JC.hiddenContent surface.
// (Converted from js/enhanced/hidden-content-init.js — body verbatim except the
// two-line data reset, which moved into resetFromUserConfig() in
// hidden-content/data.ts where the hiddenData closure variable lives.)
// Loads last among the hidden-content/* modules.

import { JC } from '../../globals';
import { createStableMethodFacade } from '../../core/feature-loader';
import {
    resetFromUserConfig,
    isHidden,
    isHiddenByTmdbId,
    isHiddenMedia,
    getHiddenStorageKey,
    hideItem,
    unhideItem,
    getSettings,
    updateSettings,
    getAllHiddenItems,
    getHiddenCount,
    filterSeerrResults,
    filterCalendarEvents,
    filterRequestItems,
    unhideAll,
    refresh,
    markScopedHidden,
    resolveLegacyIdentity,
} from './data';
import {
    flushPendingSave,
    fetchHiddenContentUsers,
    fetchUserHiddenItemsForAdmin,
    adminUnhideForUser,
    adminHideForUser,
} from './save';
import { injectCSS } from './styles';
import { showUndoToast, confirmAndHide } from './dialogs';
import { showManagementPanel, createItemCard } from './panel';
import {
    setupNativeObserver,
    filterAllNativeCards,
    isHiddenOnSurface,
    filterNativeCards,
} from './filter';
import { addLibraryHideButtons, removeLibraryHideButtons } from './buttons';

/** Initial filter delay after module initialization. */
const INIT_FILTER_DELAY_MS = 150;
let initialFilterTimeout: number | null = null;

export function cancelInitialFilter(): void {
    if (initialFilterTimeout != null) clearTimeout(initialFilterTimeout);
    initialFilterTimeout = null;
}

// ============================================================
// Initialization
// ============================================================

/**
 * Initializes the hidden content module: loads data, rebuilds lookup sets,
 * injects CSS, sets up the MutationObserver, and exposes the public API.
 */
export function initializeHiddenContent(): void {
    const context = JC.identity?.capture?.() || null;
    if (context && !JC.identity.isCurrent(context)) return;
    cancelInitialFilter();
    resetFromUserConfig();
    injectCSS();
    setupNativeObserver();

    if (getHiddenCount() > 0) {
        initialFilterTimeout = window.setTimeout(() => {
            initialFilterTimeout = null;
            if (!context || JC.identity.isCurrent(context)) filterAllNativeCards();
        }, INIT_FILTER_DELAY_MS);
    }

    console.log(`🪼 Jellyfin Canopy: Hidden Content initialized (${getHiddenCount()} items hidden)`);
}

const hiddenContentApi = {
    isHidden,
    isHiddenByTmdbId,
    isHiddenMedia,
    getHiddenStorageKey,
    isHiddenOnSurface,
    hideItem,
    unhideItem,
    confirmAndHide,
    getSettings,
    updateSettings,
    getAllHiddenItems,
    getHiddenCount,
    filterSeerrResults,
    filterCalendarEvents,
    filterRequestItems,
    filterNativeCards,
    showUndoToast,
    showManagementPanel,
    createItemCard,
    unhideAll,
    addLibraryHideButtons,
    removeLibraryHideButtons,
    refresh,
    markScopedHidden,
    resolveLegacyIdentity,
    flushPendingSave,
    fetchHiddenContentUsers,
    fetchUserHiddenItemsForAdmin,
    adminUnhideForUser,
    adminHideForUser,
};

const fallbackHiddenContent = Object.fromEntries(
    Object.keys(hiddenContentApi).map((key) => [key, () => undefined]),
) as unknown as typeof hiddenContentApi;
const stableHiddenContent = createStableMethodFacade<typeof hiddenContentApi>(fallbackHiddenContent);
const stableInitializer = createStableMethodFacade({ initialize() {} });

/** Publish stable public facades for one loader-owned activation. */
export function installHiddenContent(): () => void {
    const uninstallApi = stableHiddenContent.install(hiddenContentApi);
    const uninstallInitializer = stableInitializer.install({ initialize: initializeHiddenContent });
    JC.hiddenContent = stableHiddenContent.facade;
    JC.initializeHiddenContent = stableInitializer.facade.initialize;
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        cancelInitialFilter();
        uninstallInitializer();
        uninstallApi();
    };
}
