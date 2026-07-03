// src/arr/calendar-page-init.ts (formerly js/arr/calendar-page-init.js)
// Calendar Page — initialization, navigation interception, page show/hide
// and the public JE.calendarPage surface (split from calendar-page.js).
// The navigation-watcher fallback interval is tracked with core lifecycle.
// Public surface (frozen): JE.calendarPage + JE.initializeCalendarPage —
// called by js/plugin.js Stage 6 and PluginPages/CalendarPage.html.

import { register as registerLifecycle } from '../core/lifecycle';
import { JE } from './arr-globals';
import { loadSettings, state } from './calendar-page-data';
import { createPageContainer, renderPage } from './calendar-page-render-views';
import { injectStyles } from './calendar-page-styles';
import {
    goToday,
    handleEventClick,
    loadAllData,
    setDisplayMode,
    setViewMode,
    shiftPeriod,
    toggleFilter,
    toggleShowUnmonitored
} from './calendar-page-actions';

/** The frozen JE.calendarPage contract (js/plugin.js + PluginPages HTML). */
export interface CalendarPageApi {
    initialize: () => void;
    showPage: () => void;
    hidePage: () => void;
    refresh: () => Promise<void>;
    setViewMode: (mode: string) => void;
    shiftPeriod: (direction: string) => void;
    goToday: () => void;
    toggleFilter: (filterType: string) => void;
    toggleShowUnmonitored: () => void;
    renderPage: (targetContainer?: HTMLElement) => void;
    renderForCustomTab: (targetContainer?: HTMLElement) => void;
    injectStyles: () => void;
    loadSettings: () => void;
    handleEventClick: (e: MouseEvent) => void;
    setDisplayMode: (mode: string) => void;
}

// Feature-scoped resource registry (interval fallback, unsubscribe fns).
const lifecycle = registerLifecycle('arr-calendar-page');

const sidebar = document.querySelector('.mainDrawer-scrollContainer');
const pluginPagesExists = !!sidebar?.querySelector(
    'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.CalendarPage"]'
);

const logPrefix = '🪼 Jellyfin Enhanced: Calendar Page:';

/**
 * Initialize calendar page
 */
function initialize(): void {
    console.log(`${logPrefix} Initializing calendar page module`);

    const config = JE.pluginConfig || {};
    if (!config.CalendarPageEnabled) {
        console.log(`${logPrefix} Calendar page is disabled`);
        return;
    }

    injectStyles();
    loadSettings();

    const usingPluginPages = pluginPagesExists && config.CalendarUsePluginPages;
    if (usingPluginPages) {
        console.log(`${logPrefix} Calendar page is injected via Plugin Pages`);
        return;
    }

    // Page-specific setup for custom tabs or dedicated page mode
    // Inject navigation and set up one-time re-injection on sidebar rebuild
    injectNavigation();
    setupNavigationWatcher();

    // Setup event listeners
    window.addEventListener('hashchange', interceptNavigation, true);
    window.addEventListener('popstate', interceptNavigation, true);
    document.addEventListener('viewshow', handleViewShow);
    document.addEventListener('click', handleNavClick);
    document.addEventListener('click', handleEventClick);

    startLocationWatcher();

    // Check location on init
    handleNavigation();

    console.log(`${logPrefix} Calendar page module initialized`);
}

// Use event-based navigation detection (pushState/hashchange/popstate via je:navigate)
function startLocationWatcher(): void {
    if (state.locationUnsubscribe) return;

    state.locationSignature = `${window.location.pathname}${window.location.hash}`;

    const check = (): void => {
        const signature = `${window.location.pathname}${window.location.hash}`;
        if (signature !== state.locationSignature) {
            state.locationSignature = signature;
            handleNavigation();
        }
    };

    // Tracked with the feature lifecycle so teardownAll() can dispose it.
    state.locationUnsubscribe = lifecycle.track(
        JE.helpers?.onNavigate
            ? JE.helpers.onNavigate(check)
            : (() => {
                const t = setInterval(check, 150);
                return () => clearInterval(t);
            })(),
    );
}

/**
 * Intercept hash/popstate changes for our route before Jellyfin router
 */
function interceptNavigation(e: HashChangeEvent | PopStateEvent): void {
    const url = (e as HashChangeEvent)?.newURL ? new URL((e as HashChangeEvent).newURL) : window.location;
    const hash = url.hash;
    const path = url.pathname;
    const matches = hash.startsWith('#/calendar') || path === '/calendar';
    if (matches) {
        if (e?.stopImmediatePropagation) e.stopImmediatePropagation();
        if (e?.preventDefault) e.preventDefault();
        showPage();
    }
}

function stopLocationWatcher(): void {
    if (state.locationUnsubscribe) {
        lifecycle.untrack(state.locationUnsubscribe);
        state.locationUnsubscribe();
        state.locationUnsubscribe = null;
    }
}

/**
 * Show page
 */
function showPage(): void {
    if (state.pageVisible) return;

    const config = JE.pluginConfig || {};
    if (!config.CalendarPageEnabled) return;
    if (pluginPagesExists && config.CalendarUsePluginPages) return;

    state.pageVisible = true;

    injectStyles();
    const page = createPageContainer();

    if (window.location.hash !== '#/calendar') {
        history.pushState({ page: 'calendar' }, 'Calendar', '#/calendar');
    }

    const activePage = document.querySelector('.mainAnimatedPage:not(.hide):not(#je-calendar-page)');
    if (activePage) {
        state.previousPage = activePage;
        activePage.classList.add('hide');
        activePage.dispatchEvent(
            new CustomEvent('viewhide', {
                bubbles: true,
                detail: { type: 'interior' },
            }),
        );
    }

    page.classList.remove('hide');

    page.dispatchEvent(
        new CustomEvent('viewshow', {
            bubbles: true,
            detail: {
                type: 'custom',
                isRestored: false,
                options: {},
            },
        }),
    );

    page.dispatchEvent(
        new CustomEvent('pageshow', {
            bubbles: true,
            detail: {},
        }),
    );

    // Only load data once (guard against showPage retries)
    if (!state.isLoading) {
        void loadAllData();
    }
}

/**
 * Hide page
 */
function hidePage(): void {
    if (!state.pageVisible) return;

    const page = document.getElementById('je-calendar-page');
    if (page) {
        page.classList.add('hide');
        page.dispatchEvent(
            new CustomEvent('viewhide', {
                bubbles: true,
                detail: { type: 'custom' },
            }),
        );
    }

    // Restore the previous page if Jellyfin's router hasn't already shown another page
    if (state.previousPage && !document.querySelector('.mainAnimatedPage:not(.hide):not(#je-calendar-page)')) {
        state.previousPage.classList.remove('hide');
        state.previousPage.dispatchEvent(
            new CustomEvent('viewshow', {
                bubbles: true,
                detail: { type: 'interior', isRestored: true },
            }),
        );
    }

    state.pageVisible = false;
    state.previousPage = null;
    stopLocationWatcher();
}

/**
 * Handle navigation
 */
function handleNavigation(): void {
    const hash = window.location.hash;
    const path = window.location.pathname;
    if (hash === '#/calendar' || path === '/calendar') {
        showPage();
    } else if (state.pageVisible) {
        hidePage();
    }
}

/**
 * Handle viewshow events
 */
function handleViewShow(e: Event): void {
    const targetPage = e.target as Element | null;
    if (state.pageVisible && targetPage && targetPage.id !== 'je-calendar-page') {
        hidePage();
    }
}

/**
 * Handle nav click
 */
function handleNavClick(e: MouseEvent): void {
    if (!state.pageVisible) return;

    const btn = (e.target as Element | null)?.closest('.headerTabs button, .navMenuOption, .headerButton');
    if (btn && !btn.classList.contains('je-nav-calendar-item')) {
        hidePage();
    }
}

/**
 * Inject navigation item into sidebar
 */
function injectNavigation(): void {
    const config = JE.pluginConfig || {};
    if (!config.CalendarPageEnabled) return;
    if (pluginPagesExists && config.CalendarUsePluginPages) return;
    if (config.CalendarUseCustomTabs) return; // Skip if using custom tabs
    if (config.CalendarUseNativeTab) return; // Skip if using the native tab

    // Hide plugin page link if it exists
    const pluginPageItem = sidebar?.querySelector<HTMLElement>(
        'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.CalendarPage"]'
    );

    if (pluginPageItem) {
        pluginPageItem.style.setProperty('display', 'none', 'important');
    }

    // Check if already exists
    if (document.querySelector('.je-nav-calendar-item')) {
        return;
    }

    const jellyfinEnhancedSection = document.querySelector('.jellyfinEnhancedSection');

    if (jellyfinEnhancedSection) {
        const navItem = document.createElement('a');
        navItem.setAttribute('is', 'emby-linkbutton');
        navItem.className =
            'navMenuOption lnkMediaFolder emby-button je-nav-calendar-item';
        navItem.href = '#';
        navItem.innerHTML = `
        <span class="navMenuOptionIcon material-icons">calendar_today</span>
        <span class="sectionName navMenuOptionText">${JE.t?.('calendar_title')}</span>
      `;
        navItem.addEventListener('click', (e) => {
            e.preventDefault();
            showPage();
        });

        jellyfinEnhancedSection.appendChild(navItem);
        console.log(`${logPrefix} Navigation item injected`);
    } else {
        console.log(`${logPrefix} jellyfinEnhancedSection not found, will wait for it`);
    }
}

/**
 * Setup navigation watcher - observes only when link is missing
 */
function setupNavigationWatcher(): void {
    const config = JE.pluginConfig || {};
    if (!config.CalendarPageEnabled) return;
    if (pluginPagesExists && config.CalendarUsePluginPages) return;
    if (config.CalendarUseCustomTabs) return; // Don't watch if using custom tabs
    if (config.CalendarUseNativeTab) return; // Don't watch if using the native tab

    // Use MutationObserver to watch for sidebar changes, but disconnect after re-injection
    const observer = new MutationObserver(() => {
        // Re-check config each time to avoid injecting when settings change
        const currentConfig = JE.pluginConfig || {};
        if (currentConfig.CalendarUseCustomTabs) return;
        if (currentConfig.CalendarUseNativeTab) return;
        if (pluginPagesExists && currentConfig.CalendarUsePluginPages) return;

        if (!document.querySelector('.je-nav-calendar-item')) {
            const jellyfinEnhancedSection = document.querySelector('.jellyfinEnhancedSection');
            if (jellyfinEnhancedSection) {
                console.log(`${logPrefix} Sidebar rebuilt, re-injecting navigation`);
                injectNavigation();
            }
        }
    });

    // Observe the main drawer
    const navDrawer = document.querySelector('.mainDrawer, .navDrawer, body');
    if (navDrawer) {
        observer.observe(navDrawer, { childList: true, subtree: true });
    }
}

/**
 * Render content for custom tabs (without page state management).
 * @param targetContainer - Optional container element to
 *   render into, avoiding global getElementById lookups.
 */
function renderForCustomTab(targetContainer?: HTMLElement): void {
    injectStyles();
    loadSettings();
    renderPage(targetContainer);
    void loadAllData();
}

// Export to JE namespace
JE.calendarPage = {
    initialize,
    showPage,
    hidePage,
    refresh: loadAllData,
    setViewMode,
    shiftPeriod,
    goToday,
    toggleFilter,
    toggleShowUnmonitored,
    renderPage,
    renderForCustomTab,
    injectStyles,
    loadSettings,
    handleEventClick,
    setDisplayMode
};

JE.initializeCalendarPage = initialize;
