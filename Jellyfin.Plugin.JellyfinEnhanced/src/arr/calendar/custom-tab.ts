// src/arr/calendar-custom-tab.ts (formerly js/arr/calendar-custom-tab.js)
//
// Calendar Custom Tab
// Creates <div class="jellyfinenhanced calendar"></div>, either inside a tab
// panel managed by the external Custom Tabs plugin (CalendarUseCustomTabs),
// or inside a panel JE creates itself via the shared native-tabs registry
// (CalendarUseNativeTab, see enhanced/native-tabs.js) -- no external plugin
// needed for the latter. The rest of this file doesn't care which one
// created the wrapping panel.
//
// Uses a persistent observer to remount whenever the home page DOM is rebuilt
// (e.g. after SPA navigation). Only runs when on the home page; suspends
// when navigated away.

import { JE } from '../arr-globals';
import type { ArrJE } from '../arr-globals';

(function () {
    if (!JE?.pluginConfig?.CalendarPageEnabled) {
        return;
    }

    const useCustomTabs = !!JE?.pluginConfig?.CalendarUseCustomTabs;
    const useNativeTab = !!JE?.pluginConfig?.CalendarUseNativeTab;

    if (!useCustomTabs && !useNativeTab) {
        return;
    }

    if (useNativeTab) {
        JE.nativeTabs?.register('calendar', 'Calendar', function (panel) {
            const marker = document.createElement('div');
            marker.className = 'jellyfinenhanced calendar';
            panel.appendChild(marker);
        }, 'calendar_month');
    }

    const style = document.createElement('style');
    style.textContent = [
        '.jellyfinenhanced.calendar {',
        '  padding: 12px 3vw;',
        '}',
        '.backgroundContainer.withBackdrop:has(~ .mainAnimatedPages #indexPage .tabContent.is-active .jellyfinenhanced.calendar) {',
        '  background: rgba(0, 0, 0, 0.7) !important;',
        '}'
    ].join('\n');
    document.head.appendChild(style);

    /** The last DOM node we mounted into. */
    let lastMountedContainer: HTMLElement | null = null;
    let clickHandlerAttached = false;

    /** @returns Whether the current URL hash is the home page. */
    function isOnHomePage(): boolean {
        const hash = window.location.hash;
        return hash === '' || hash === '#/home' || hash === '#/home.html'
            || hash.indexOf('#/home?') !== -1 || hash.indexOf('#/home.html?') !== -1;
    }

    /** Wait for JE.calendarPage to be ready before initializing (30s timeout). */
    function waitForCalendar(callback: (je: ArrJE) => void): void {
        let attempts = 0;
        const check = setInterval(function () {
            if (++attempts > 300) { clearInterval(check); return; }
            if (JE?.calendarPage) {
                clearInterval(check);
                callback(JE);
            }
        }, 100);
    }

    /**
     * Find the calendar container inside the active (non-hidden) home page.
     * Returns null if no visible container exists -- never falls back to a
     * stale DOM-cached copy.
     *
     * Tries three anchors in order so the mount works regardless of how the
     * host plugin (Custom Tabs, Plugin Pages, etc.) wraps the content:
     *  1. Nearest `.page` ancestor that doesn't have `.hide`  (standard Jellyfin)
     *  2. Nearest `.tabContent` ancestor that has `.is-active`  (Custom Tabs fallback)
     *  3. Element is itself visible (offsetParent !== null)     (last resort)
     */
    function findActiveContainer(): HTMLElement | null {
        const all = document.querySelectorAll<HTMLElement>('.jellyfinenhanced.calendar');
        for (let i = all.length - 1; i >= 0; i--) {
            const el = all[i];
            // 1. Standard Jellyfin page structure
            const page = el.closest('.page');
            if (page && !page.classList.contains('hide')) return el;
            // 2. Custom Tabs wraps content in .tabContent.is-active (no .page ancestor)
            const tabContent = el.closest('.tabContent');
            if (tabContent && tabContent.classList.contains('is-active')) return el;
            // 3. Last resort: element is simply visible in the document
            if (!page && !tabContent && el.offsetParent !== null) return el;
        }
        return null;
    }

    /**
     * Render calendar into the given container using a scoped child element.
     * @param container - The active .jellyfinenhanced.calendar element.
     * @param je - The JellyfinEnhanced global object.
     */
    function renderCalendar(container: HTMLElement, je: ArrJE): void {
        container.classList.remove('hide');
        container.style.display = '';

        const child = document.createElement('div');
        child.id = 'je-calendar-container-tab';
        container.textContent = '';
        container.appendChild(child);

        je.calendarPage?.renderForCustomTab?.(child);

        if (!clickHandlerAttached && typeof je.calendarPage?.handleEventClick === 'function') {
            document.addEventListener('click', je.calendarPage.handleEventClick);
            clickHandlerAttached = true;
        }

        lastMountedContainer = container;
    }

    /**
     * Persistent watcher -- observes document.body (via shared observer) for
     * DOM rebuilds and remounts the calendar when a new active container
     * appears. Suspends checks when not on the home page.
     * @param je - The JellyfinEnhanced global object.
     */
    function watchForContainer(je: ArrJE): void {
        function tryMount(): void {
            // Skip work entirely when not on the home page
            if (!isOnHomePage()) return;

            const container = findActiveContainer();
            if (!container) {
                lastMountedContainer = null;
                return;
            }

            const shouldMount = container !== lastMountedContainer
                || !container.hasChildNodes()
                || (lastMountedContainer && !document.contains(lastMountedContainer));

            if (shouldMount) {
                renderCalendar(container, je);
            }
        }

        tryMount();

        // Observe document.body (not .mainAnimatedPages) because Jellyfin replaces
        // .mainAnimatedPages when navigating to the admin dashboard — an observer
        // bound to the old element would become orphaned after returning to home
        // (issue 536). Routes to the shared multiplexed body observer.
        let mountPending = false;
        je.helpers?.createObserver?.('arr-calendar-custom-tab', function () {
            if (!mountPending) {
                mountPending = true;
                requestAnimationFrame(function () {
                    mountPending = false;
                    tryMount();
                });
            }
        }, document.body, { childList: true, subtree: true });
    }

    waitForCalendar(function (je) {
        watchForContainer(je);
    });

})();
