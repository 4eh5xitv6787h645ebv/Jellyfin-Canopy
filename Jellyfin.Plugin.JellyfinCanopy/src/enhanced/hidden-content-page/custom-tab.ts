// src/enhanced/hidden-content-page/custom-tab.ts
//
// Hidden Content Custom Tab
// Creates <div class="jellyfincanopy hidden-content"></div>, either inside a
// tab panel managed by the external Custom Tabs plugin
// (HiddenContentUseCustomTabs), or inside a panel JC creates itself via the
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

    if (!window.JellyfinCanopy?.pluginConfig?.HiddenContentEnabled) {
        return;
    }

    const useCustomTabs = !!window.JellyfinCanopy?.pluginConfig?.HiddenContentUseCustomTabs;
    const useNativeTab = !!window.JellyfinCanopy?.pluginConfig?.HiddenContentUseNativeTab;

    if (!useCustomTabs && !useNativeTab) {
        return;
    }

    if (useNativeTab) {
        window.JellyfinCanopy.nativeTabs!.register('hidden-content', 'Hidden Content', function (panel) {
            const marker = document.createElement('div');
            marker.className = 'jellyfincanopy hidden-content';
            panel.appendChild(marker);
        }, 'remove_red_eye');
    }

    const style = document.createElement('style');
    style.textContent = [
        '.jellyfincanopy.hidden-content {',
        '  padding: 12px 3vw;',
        '}',
        '.backgroundContainer.withBackdrop:has(~ .mainAnimatedPages #indexPage .tabContent.is-active .jellyfincanopy.hidden-content) {',
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

    /** Wait for JC.hiddenContentPage and JC.hiddenContent to be ready before initializing (30s timeout). */
    function waitForHiddenContent(callback: (JC: any) => void): void {
        let attempts = 0;
        const check = setInterval(function () {
            if (++attempts > 300) { clearInterval(check); return; }
            const JC = (window as any).JC || window.JellyfinCanopy;
            if (JC?.hiddenContentPage && JC?.hiddenContent) {
                clearInterval(check);
                callback(JC);
            }
        }, 100);
    }

    /**
     * Find the hidden content container inside the active (non-hidden) home page.
     * Returns null if no visible container exists -- never falls back to a
     * stale DOM-cached copy.
     */
    function findActiveContainer(): HTMLElement | null {
        const all = document.querySelectorAll<HTMLElement>('.jellyfincanopy.hidden-content');
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
     * @param container - The active .jellyfincanopy.hidden-content element.
     * @param JC - The JellyfinCanopy global object.
     */
    function renderHiddenContent(container: HTMLElement, JC: any): void {
        if (!container || !JC.hiddenContentPage) return;

        container.classList.remove('hide');
        container.style.display = '';

        const child = document.createElement('div');
        child.id = 'jc-hidden-content-container-tab';
        container.textContent = '';
        container.appendChild(child);

        JC.hiddenContentPage.renderForCustomTab?.(child);

        lastMountedContainer = container;
    }

    /**
     * Persistent watcher -- observes document.body (via shared observer) for
     * DOM rebuilds and remounts the hidden content tab when a new active
     * container appears. Suspends checks when not on the home page.
     * @param JC - The JellyfinCanopy global object.
     */
    function watchForContainer(JC: any): void {
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
                renderHiddenContent(container, JC);
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

    waitForHiddenContent(function (JC: any) {
        watchForContainer(JC);
    });

})();
