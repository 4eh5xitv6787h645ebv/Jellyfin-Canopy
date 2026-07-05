// src/enhanced/hidden-content-custom-tab.ts
//
// Hidden Content Custom Tab
// Creates <div class="jellyfinenhanced hidden-content"></div>, either inside a
// tab panel managed by the external Custom Tabs plugin
// (HiddenContentUseCustomTabs), or inside a panel JE creates itself via the
// shared native-tabs registry (HiddenContentUseNativeTab, see
// enhanced/native-tabs.ts) -- no external plugin needed for the latter. The
// rest of this file doesn't care which one created the wrapping panel.
//
// Uses a persistent observer to remount whenever the home page DOM is rebuilt
// (e.g. after SPA navigation). Only runs when on the home page; suspends
// when navigated away.
// (Converted from js/enhanced/hidden-content-custom-tab.js — bodies semantically
// identical. The original file's top-level early-returns are preserved by
// keeping the body inside an IIFE.)

import { createObserver } from '../../core/dom-observer';

/* eslint-disable @typescript-eslint/no-explicit-any */

(function () {
    'use strict';

    if (!window.JellyfinEnhanced?.pluginConfig?.HiddenContentEnabled) {
        return;
    }

    const useCustomTabs = !!window.JellyfinEnhanced?.pluginConfig?.HiddenContentUseCustomTabs;
    const useNativeTab = !!window.JellyfinEnhanced?.pluginConfig?.HiddenContentUseNativeTab;

    if (!useCustomTabs && !useNativeTab) {
        return;
    }

    if (useNativeTab) {
        window.JellyfinEnhanced.nativeTabs!.register('hidden-content', 'Hidden Content', function (panel) {
            const marker = document.createElement('div');
            marker.className = 'jellyfinenhanced hidden-content';
            panel.appendChild(marker);
        }, 'remove_red_eye');
    }

    const style = document.createElement('style');
    style.textContent = [
        '.jellyfinenhanced.hidden-content {',
        '  padding: 12px 3vw;',
        '}',
        '.backgroundContainer.withBackdrop:has(~ .mainAnimatedPages #indexPage .tabContent.is-active .jellyfinenhanced.hidden-content) {',
        '  background: rgba(0, 0, 0, 0.7) !important;',
        '}'
    ].join('\n');
    document.head.appendChild(style);

    /** The last DOM node we mounted into. */
    let lastMountedContainer: HTMLElement | null = null;

    /** @returns Whether the current URL hash is the home page. */
    function isOnHomePage(): boolean {
        const hash = window.location.hash;
        return hash === '' || hash === '#/home' || hash === '#/home.html'
            || hash.indexOf('#/home?') !== -1 || hash.indexOf('#/home.html?') !== -1;
    }

    /** Wait for JE.hiddenContentPage and JE.hiddenContent to be ready before initializing (30s timeout). */
    function waitForHiddenContent(callback: (JE: any) => void): void {
        let attempts = 0;
        const check = setInterval(function () {
            if (++attempts > 300) { clearInterval(check); return; }
            const JE = (window as any).JE || window.JellyfinEnhanced;
            if (JE?.hiddenContentPage && JE?.hiddenContent) {
                clearInterval(check);
                callback(JE);
            }
        }, 100);
    }

    /**
     * Find the hidden content container inside the active (non-hidden) home page.
     * Returns null if no visible container exists -- never falls back to a
     * stale DOM-cached copy.
     */
    function findActiveContainer(): HTMLElement | null {
        const all = document.querySelectorAll<HTMLElement>('.jellyfinenhanced.hidden-content');
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
     * Render hidden content into the given container using a scoped child element.
     * @param container - The active .jellyfinenhanced.hidden-content element.
     * @param JE - The JellyfinEnhanced global object.
     */
    function renderHiddenContent(container: HTMLElement, JE: any): void {
        if (!container || !JE.hiddenContentPage) return;

        container.classList.remove('hide');
        container.style.display = '';

        const child = document.createElement('div');
        child.id = 'je-hidden-content-container-tab';
        container.textContent = '';
        container.appendChild(child);

        JE.hiddenContentPage.renderForCustomTab?.(child);

        lastMountedContainer = container;
    }

    /**
     * Persistent watcher -- observes document.body (via shared observer) for
     * DOM rebuilds and remounts the hidden content tab when a new active
     * container appears. Suspends checks when not on the home page.
     * @param JE - The JellyfinEnhanced global object.
     */
    function watchForContainer(JE: any): void {
        function tryMount(): void {
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
                renderHiddenContent(container, JE);
            }
        }

        tryMount();

        // Observe document.body (not .mainAnimatedPages) because Jellyfin replaces
        // .mainAnimatedPages when navigating to the admin dashboard — an observer
        // bound to the old element would become orphaned after returning to home
        // (issue 536). Routes to the shared multiplexed body observer.
        let mountPending = false;
        createObserver('hidden-content-custom-tab', function () {
            if (!mountPending) {
                mountPending = true;
                requestAnimationFrame(function () {
                    mountPending = false;
                    tryMount();
                });
            }
        }, document.body, { childList: true, subtree: true });
    }

    waitForHiddenContent(function (JE: any) {
        watchForContainer(JE);
    });

})();
