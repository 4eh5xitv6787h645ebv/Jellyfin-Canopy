// src/discovery/home-tab.ts
//
// Adds a "Discovery" tab to the Home screen via the shared native-tabs registry (the same framework
// the Requests/Calendar tabs use, so it's native on both layouts). It hosts the shared Discovery
// surface (pane.ts) with a Movies/TV toggle since Home isn't scoped to one media type. Admin opt-in
// (DiscoveryHomeTab, default off) so it doesn't add Home nav for everyone. A scoped body-observer
// re-mounts on SPA re-render; it tears down when navigated away from Home.

import { JE } from '../globals';
import { onNavigate } from '../core/navigation';
import { injectCss } from '../core/ui-kit';
import { createDiscoveryPane, type DiscoveryPaneHandle } from './pane';

const MARKER = 'je-discovery-home';

function enabled(): boolean {
    if (JE.pluginConfig?.DiscoveryEnabled === false) return false;
    if (JE.pluginConfig?.DiscoveryHomeTab !== true) return false; // opt-in
    return JE.pluginConfig?.JellyseerrEnabled === true;
}

function isOnHomePage(): boolean {
    const hash = window.location.hash;
    return hash === '' || hash === '#/home' || hash === '#/home.html'
        || hash.indexOf('#/home?') !== -1 || hash.indexOf('#/home.html?') !== -1;
}

let pane: DiscoveryPaneHandle | null = null;
let mountedInto: HTMLElement | null = null;

/** The Discovery marker inside the active (non-hidden) home tab panel, or null. */
function findActiveMarker(): HTMLElement | null {
    const all = document.querySelectorAll<HTMLElement>('.' + MARKER);
    for (let i = all.length - 1; i >= 0; i--) {
        const el = all[i];
        const page = el.closest('.page');
        if (page && !page.classList.contains('hide')) return el;
        const tabContent = el.closest('.tabContent');
        if (tabContent && tabContent.classList.contains('is-active')) return el;
        if (!page && !tabContent && el.offsetParent !== null) return el;
    }
    return null;
}

function teardown(): void {
    pane?.destroy();
    pane = null;
    mountedInto = null;
}

function tryMount(): void {
    if (!isOnHomePage()) { if (pane) teardown(); return; }
    const marker = findActiveMarker();
    if (!marker) {
        if (mountedInto && !document.contains(mountedInto)) teardown();
        return;
    }
    const shouldMount = marker !== mountedInto || !marker.hasChildNodes()
        || (mountedInto !== null && !document.contains(mountedInto));
    if (shouldMount) {
        pane?.destroy();
        marker.textContent = '';
        pane = createDiscoveryPane('movie', true);
        marker.appendChild(pane.element);
        mountedInto = marker;
    }
}

/** Wires the Home-screen Discovery tab. Idempotent; a no-op unless admin-enabled + Seerr configured. */
export function initHomeTab(): void {
    if (!enabled()) return;
    injectCss('je-discovery-home-css', `.${MARKER} { padding: 12px 3vw; }`);
    JE.nativeTabs?.register('discovery', 'Discovery', (panel) => {
        const marker = document.createElement('div');
        marker.className = MARKER;
        panel.appendChild(marker);
    }, 'explore');

    let pending = false;
    JE.core.dom!.onBodyMutation('je-discovery-home', () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; tryMount(); });
    });
    onNavigate(tryMount);
    tryMount();
}
