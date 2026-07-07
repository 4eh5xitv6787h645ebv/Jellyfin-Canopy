// src/enhanced/hidden-content/init.ts
//
// Hidden Content — initialization: wires the modules together and
// exposes the frozen JE.initializeHiddenContent / JE.hiddenContent surface.
// (Converted from js/enhanced/hidden-content-init.js — body verbatim except the
// two-line data reset, which moved into resetFromUserConfig() in
// hidden-content/data.ts where the hiddenData closure variable lives.)
// Loads last among the hidden-content/* modules.

import { JE } from '../../globals';
import {
    resetFromUserConfig,
    isHidden,
    isHiddenByTmdbId,
    hideItem,
    unhideItem,
    getSettings,
    updateSettings,
    getAllHiddenItems,
    getHiddenCount,
    filterJellyseerrResults,
    filterCalendarEvents,
    filterRequestItems,
    unhideAll,
    refresh,
    markScopedHidden,
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

// ============================================================
// Initialization
// ============================================================

/**
 * Initializes the hidden content module: loads data, rebuilds lookup sets,
 * injects CSS, sets up the MutationObserver, and exposes the public API.
 */
JE.initializeHiddenContent = function (): void {
    resetFromUserConfig();
    injectCSS();
    setupNativeObserver();

    if (getHiddenCount() > 0) {
        setTimeout(filterAllNativeCards, INIT_FILTER_DELAY_MS);
    }

    // Expose public API
    JE.hiddenContent = {
        isHidden,
        isHiddenByTmdbId,
        isHiddenOnSurface,
        hideItem,
        unhideItem,
        confirmAndHide,
        getSettings,
        updateSettings,
        getAllHiddenItems,
        getHiddenCount,
        filterJellyseerrResults,
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
        flushPendingSave,
        // Admin-only cross-user visibility + editing
        fetchHiddenContentUsers,
        fetchUserHiddenItemsForAdmin,
        adminUnhideForUser,
        adminHideForUser
    };

    console.log(`🪼 Jellyfin Elevate: Hidden Content initialized (${getHiddenCount()} items hidden)`);
};
