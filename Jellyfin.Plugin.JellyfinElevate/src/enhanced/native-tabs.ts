// src/enhanced/native-tabs.ts
//
// Shared registry for adding self-contained tabs to the Home page's native tab
// strip, without depending on the external Custom Tabs plugin.
// (Converted from js/enhanced/native-tabs.js — bodies semantically identical.)
//
// Jellyfin's own tab mechanism (components/maintabsmanager.js + the emby-tabs
// element) is generic: a button in `.emby-tabs-slider` with `data-index="N"`
// and a `.tabContent.pageTabContent` panel at DOM position N (relative to the
// other panels) is all it takes. Jellyfin wires up the click-to-switch and
// .is-active toggling itself, the same way it does for its own Home/Favorites
// tabs (index 0/1) and the same way the Custom Tabs plugin adds its own tabs.
// This is the exact mechanism the Custom Tabs plugin uses internally, just
// run from JE's own already-injected script instead of a separate plugin.
//
// Works on Jellyfin 12's legacy layout, where `.emby-tabs-slider` is part
// of the normal, visible header. On
// Jellyfin 12's modern (React/MUI) layout the tab *button* itself is invisible
// (it lives inside `.skinHeader`, which that layout hides, see
// getHeaderRightContainer in helpers.ts for the equivalent header-button
// problem), but the tab *panel* is not inside `.skinHeader` and stays fully
// reachable: navigating to `#/home?tab=N` (Jellyfin's own deep-link
// convention, used natively for `?tab=1` = Favorites) still activates it.

import { JE } from '../globals';
import { onNavigate } from '../core/navigation';
import { getHeaderRightContainer } from './helpers';

declare global {
    interface Window {
        /** Custom-elements polyfill hook exposed by jellyfin-web. */
        CustomElements?: { upgradeSubtree?: (root: Element) => void };
    }
}

interface NativeTabEntry {
    id: string;
    title: string;
    onMount: (panel: HTMLElement) => void;
    icon?: string;
    index?: number | null;
}

/** Ordered list of {id, title, onMount, index}. Order determines data-index assignment. */
let entries: NativeTabEntry[] = [];
let injectPending = false;
// PERF(R1): link ids that already had their one-time boot entrance animation.
// Re-injections (header re-mounts) attach instantly — they run rAF-coalesced
// off the remount mutation, i.e. before the rebuilt header's first paint.
const animatedLinkIds = new Set<string>();

function isOnHomePage(): boolean {
    const hash = window.location.hash;
    return hash === '' || hash === '#/home' || hash === '#/home.html'
        || hash.indexOf('#/home?') !== -1 || hash.indexOf('#/home.html?') !== -1;
}

/** The shared parent of all native `.tabContent.pageTabContent` panels (Home's page root). */
function getTabsRoot(): HTMLElement | null {
    const nativePanel = document.querySelector('.tabContent.pageTabContent[data-index="0"]');
    return nativePanel ? nativePanel.parentElement : null;
}

/**
 * Highest `data-index` currently in use on the tab strip, plus 1. Scanning
 * live rather than assuming "native tabs are 0/1, ours start at 2" matters
 * because the external Custom Tabs plugin claims indices the exact same
 * way (`i + 2`, with no collision checking of its own either) -- if a user
 * runs both, blindly assuming an index is free would clash with it.
 */
function nextFreeIndex(slider: Element): number {
    let max = 1; // native Home(0)/Favorites(1) always present
    slider.querySelectorAll('[data-index]').forEach(function (el) {
        const idx = parseInt(el.getAttribute('data-index') || '', 10);
        if (!isNaN(idx) && idx > max) max = idx;
    });
    return max + 1;
}

function ensureInjected(): void {
    if (entries.length === 0) return;

    if (!isOnHomePage()) {
        console.debug('🪼 Jellyfin Elevate: [native-tabs] not on home page (hash=' + window.location.hash + '), skipping');
        return;
    }

    const slider = document.querySelector('.emby-tabs-slider');
    const root = getTabsRoot();
    if (!slider || !root) {
        console.debug('🪼 Jellyfin Elevate: [native-tabs] waiting for DOM - .emby-tabs-slider ' +
            (slider ? 'found' : 'MISSING') + ', tab panel root ' + (root ? 'found' : 'MISSING'));
        return;
    }

    entries.forEach(function (entry) {
        // Assign the index once and cache it -- recomputing on every pass
        // could hand an entry a *different* index later (if something else's
        // tabs come and go), which would desync its already-created button
        // from its already-created panel.
        if (entry.index == null) {
            entry.index = nextFreeIndex(slider);
        }

        if (!document.getElementById('je-native-tab-btn-' + entry.id)) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.setAttribute('is', 'emby-button');
            btn.id = 'je-native-tab-btn-' + entry.id;
            btn.className = 'emby-tab-button';
            btn.setAttribute('data-index', String(entry.index));

            const label = document.createElement('div');
            label.className = 'emby-button-foreground';
            label.textContent = entry.title;
            btn.appendChild(label);

            slider.appendChild(btn);
            window.CustomElements?.upgradeSubtree?.(slider);
            console.log('🪼 Jellyfin Elevate: [native-tabs] added tab button "' + entry.title + '" at data-index=' + entry.index);
        }

        if (!document.getElementById('je-native-tab-panel-' + entry.id)) {
            const panel = document.createElement('div');
            panel.id = 'je-native-tab-panel-' + entry.id;
            panel.className = 'tabContent pageTabContent';
            panel.setAttribute('data-index', String(entry.index));
            root.appendChild(panel);
            entry.onMount(panel);
            console.log('🪼 Jellyfin Elevate: [native-tabs] added tab panel "' + entry.title + '" at data-index=' + entry.index);
        }

        ensureDiscoverable(entry);
    });

    syncDeepLink();
}

/**
 * Header-tray group holding every fallback link, plus a trailing `|`
 * separator between it and the random-button/active-streams group. Given
 * `order: -1`, it always renders first within the tray regardless of DOM
 * insertion order -- random button and active-streams each run their own
 * independent retry loop, so racing them on raw prepend() timing is not
 * reliable; flexbox order sidesteps the race entirely.
 */
function getOrCreateGroup(headerRight: HTMLElement): HTMLElement {
    let group = document.getElementById('je-native-tabs-group');
    if (group) return group;

    group = document.createElement('div');
    group.id = 'je-native-tabs-group';
    group.style.cssText = 'display:flex;align-items:center;order:-1;';

    const separator = document.createElement('span');
    separator.id = 'je-native-tabs-separator';
    separator.setAttribute('aria-hidden', 'true');
    separator.style.cssText = 'display:inline-block;width:1px;height:1.4em;margin:0 0.5em;background:rgba(255,255,255,0.3);';
    group.appendChild(separator);

    headerRight.appendChild(group);
    return group;
}

function removeGroupIfEmpty(): void {
    const group = document.getElementById('je-native-tabs-group');
    // Only the separator left -> nothing to separate -> drop the whole group.
    if (group && group.children.length <= 1) {
        group.remove();
    }
}

/**
 * On Jellyfin 12's experimental layout the tab strip button lives inside
 * `.skinHeader`, which that layout hides -- so the button exists but is
 * never visible to click. When that's detected, add a fallback entry
 * point in the header button tray (the same `.headerRight`/MUI-toolbar
 * container random-button-style features use) that deep-links to
 * `#/home?tab=N`. Skipped entirely when the real tab button is already
 * visible (old/stable layout), so that layout doesn't get a redundant
 * second way to reach the same tab.
 */
function ensureDiscoverable(entry: NativeTabEntry): void {
    const btn = document.getElementById('je-native-tab-btn-' + entry.id);
    const linkId = 'je-native-tab-link-' + entry.id;

    if (btn && btn.offsetParent !== null) {
        document.getElementById(linkId)?.remove();
        removeGroupIfEmpty();
        return;
    }

    if (document.getElementById(linkId)) return;

    const headerRight = getHeaderRightContainer();
    if (!headerRight) return;

    const groupExisted = document.getElementById('je-native-tabs-group') !== null;
    const group = getOrCreateGroup(headerRight);
    const separator = document.getElementById('je-native-tabs-separator');

    // This fallback only appears on the modern/experimental layout (the real
    // tab button is hidden there), so build it with the native MUI AppBar
    // action-button markup via the UI kit. Legacy classes are kept so it sits
    // in the header group consistently with the other tray buttons.
    const link = JE.core.ui!.muiIconButton({
        id: linkId,
        icon: entry.icon || 'tab',
        title: entry.title,
        className: 'headerButton headerButtonRight paper-icon-button-light',
        onClick: function () {
            const hash = window.location.hash;
            const base = hash.indexOf('#/home') === 0 ? hash.split('?')[0] : '#/home';
            window.location.hash = base + '?tab=' + entry.index;
        }
    });

    group.insertBefore(link, separator);
    // PERF(R1, doctrine: reserved-space entrance): the group keeps its designed
    // slot (flex order:-1, always first in the tray). At boot the tray painted
    // long before JE loaded, so the FIRST appearance of each link expands from
    // width 0 over 150ms instead of snap-shifting the native buttons; header
    // re-mounts re-inject rAF-coalesced before the rebuilt tray's first paint,
    // so they attach instantly with no animation. When the group already
    // existed only the new link animates, otherwise the whole group (link +
    // separator) expands as one block.
    const firstAppearance = !animatedLinkIds.has(entry.id);
    animatedLinkIds.add(entry.id);
    JE.core.ui!.expandIn(groupExisted ? link : group, { instant: !firstAppearance });
    console.log('🪼 Jellyfin Elevate: [native-tabs] tab button for "' + entry.title + '" is hidden (experimental layout), added header-tray fallback link');
}

/** If the URL asks for one of our tab indices (Jellyfin's own `?tab=N` convention) but it isn't active yet, activate it. */
function syncDeepLink(): void {
    const match = /[?&]tab=(\d+)/.exec(window.location.hash);
    if (!match) return;
    const wantedIndex = parseInt(match[1], 10);
    const entry = entries.find(function (e) { return e.index === wantedIndex; });
    if (!entry) return;

    const btn = document.getElementById('je-native-tab-btn-' + entry.id);
    const tabsElem = document.querySelector<HTMLElement & { selectedIndex?: (index?: number) => number }>('[is="emby-tabs"]');
    if (btn && tabsElem?.selectedIndex && tabsElem.selectedIndex() !== wantedIndex) {
        tabsElem.selectedIndex(wantedIndex);
    }
}

function scheduleInject(): void {
    if (injectPending) return;
    injectPending = true;
    requestAnimationFrame(function () {
        injectPending = false;
        ensureInjected();
    });
}

JE.nativeTabs = {
    /**
     * Register a self-contained Home-page tab. Safe to call multiple times
     * with the same id (no-op after the first).
     * @param id - Stable identifier (e.g. "requests").
     * @param title - Tab label.
     * @param onMount - Called once with the new panel to fill it.
     * @param icon - Material Icons ligature for the header-tray fallback link. Defaults to "tab".
     */
    register: function (id: string, title: string, onMount: (panel: HTMLElement) => void, icon?: string): void {
        if (entries.some(function (e) { return e.id === id; })) return;
        entries.push({ id: id, title: title, onMount: onMount, icon: icon });
        console.log('🪼 Jellyfin Elevate: [native-tabs] registered "' + title + '" (id=' + id + ')');
        scheduleInject();
    },
    unregister: function (id: string): void {
        entries = entries.filter(function (e) { return e.id !== id; });
        document.getElementById('je-native-tab-btn-' + id)?.remove();
        document.getElementById('je-native-tab-panel-' + id)?.remove();
    }
};

JE.core.dom!.onBodyMutation('native-tabs', scheduleInject);
// Re-inject on every navigation (hashchange, popstate AND pushState navs
// the old raw hashchange listener missed).
onNavigate(scheduleInject);
