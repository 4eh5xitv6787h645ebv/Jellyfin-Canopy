// src/enhanced/hidden-content-page-init.ts
//
// Hidden Content Page — initialization and the frozen public surface
// (JE.hiddenContentPage / JE.initializeHiddenContentPage).
// (Converted from js/enhanced/hidden-content-page-init.js — bodies semantically
// identical; the JE.internals.hiddenContentPage bag is now real module imports.)
// Loads last among the hidden-content-page-* modules.

import { JE } from '../globals';
import { state, pluginPagesExists } from './hidden-content-page-state';
import { injectStyles } from './hidden-content-page-styles';
import { renderPage } from './hidden-content-page-render';
import {
    showPage, hidePage, interceptNavigation, handleNavigation, handleViewShow,
    handleNavClick, injectNavigation, setupNavigationWatcher, renderForCustomTab
} from './hidden-content-page-nav';

const logPrefix = '🪼 Jellyfin Enhanced: Hidden Content Page:';

// ============================================================
// Initialization & Setup
// ============================================================

/**
 * Initializes the hidden content page module.
 * Injects styles, navigation item, and sets up all event listeners.
 */
function initialize(): void {
    console.log(`${logPrefix} Initializing hidden content page module`);

    const config = JE.pluginConfig || {};
    if (!config.HiddenContentEnabled) {
        console.log(`${logPrefix} Hidden content is disabled`);
        return;
    }

    if (!(JE as { hiddenContent?: unknown }).hiddenContent) {
        console.log(`${logPrefix} Hidden content not initialized, skipping page module`);
        return;
    }

    injectStyles();

    // Re-render listener runs in BOTH native and Plugin-Pages modes; gated on container presence (state.pageVisible isn't set in Plugin-Pages mode).
    window.addEventListener('je-hidden-content-changed', () => {
        // This event fires only for the ADMIN's own hidden-content changes. Invalidate the cached
        // admin user list so the dropdown picks up new/emptied users on the next render.
        // Only when on the admin's own view: while viewing another user, nulling the cache would strip
        // the dropdown on the next admin-edit render until it re-fetches (a visible flicker).
        if (state.adminIsAdmin === true && !state.selectedAdminUserId) {
            state.adminUsers = null;
        }
        const container = document.getElementById('je-hidden-content-container');
        // Don't repaint while viewing another user — the admin's own change must not clobber that
        // read-only view with own-list data under the wrong badge.
        if (container && document.contains(container) && !state.selectedAdminUserId) {
            renderPage(container);
        }
    });

    const usingPluginPages = pluginPagesExists && config.HiddenContentUsePluginPages;
    if (usingPluginPages) {
        console.log(`${logPrefix} Hidden content page is injected via Plugin Pages`);
        return;
    }

    injectNavigation();
    setupNavigationWatcher();

    window.addEventListener("hashchange", interceptNavigation, true);
    window.addEventListener("popstate", interceptNavigation, true);
    document.addEventListener("viewshow", handleViewShow);
    document.addEventListener("click", handleNavClick);
    window.addEventListener("hashchange", handleNavigation);
    window.addEventListener("popstate", handleNavigation);

    handleNavigation();

    console.log(`${logPrefix} Hidden content page module initialized`);
}

// ============================================================
// Public API
// ============================================================

JE.hiddenContentPage = {
    initialize,
    showPage,
    hidePage,
    renderPage,
    renderForCustomTab,
    injectStyles,
};

JE.initializeHiddenContentPage = initialize;
