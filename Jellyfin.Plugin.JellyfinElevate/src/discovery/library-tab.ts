// src/discovery/library-tab.ts
//
// Surfaces the Discovery feed on the Movies and TV Shows library pages — the primary placement the
// user asked for, next to Suggestions/Genres/Collections. The v12 library section menu differs by
// layout: legacy is the classic emby-tabs strip; modern is a hardcoded React dropdown that crashes
// on an unknown ?tab index (LibraryPage throws on viewsByKind[type][n] === undefined). So we cannot
// register a real 8th React tab. Instead:
//   - MODERN: inject a native-looking "Discovery" item into the hardcoded library view dropdown
//     (#library-view-menu, keepMounted) next to Suggestions/Genres/Collections. It does NOT navigate
//     to a ?tab index (that would crash) — it activates our own overlay, and the menu closes like a
//     native selection. Picking any native view closes Discovery again.
//   - LEGACY (no dropdown): fall back to a "Discovery" toggle in the library header tray.
// Either way, activating mounts the shared Discovery surface (pane.ts) as an overlay over the
// library content on the stable #moviesPage/#tvshowsPage div. Re-injected on navigation + a scoped
// body-observer tick so it survives React re-renders; torn down on nav away.

import { JE } from '../globals';
import { onNavigate } from '../core/navigation';
import { getHeaderRightContainer } from '../enhanced/helpers';
import { injectCss } from '../core/ui-kit';
import type { DiscoveryMediaType } from './rows';
import { createDiscoveryPane, type DiscoveryPaneHandle } from './pane';

interface LibraryPageDef {
    id: string;
    pageSelector: string;
    mediaType: DiscoveryMediaType;
}

const PAGES: LibraryPageDef[] = [
    { id: 'movies', pageSelector: '#moviesPage', mediaType: 'movie' },
    { id: 'tvshows', pageSelector: '#tvshowsPage', mediaType: 'tv' },
];

interface PaneState {
    active: boolean;
    overlay: HTMLElement | null;
    pane: DiscoveryPaneHandle | null;
}

const state = new Map<string, PaneState>();
let injectPending = false;

function stateFor(id: string): PaneState {
    let s = state.get(id);
    if (!s) { s = { active: false, overlay: null, pane: null }; state.set(id, s); }
    return s;
}

function enabled(): boolean {
    if (JE.pluginConfig?.DiscoveryEnabled === false) return false;
    if (JE.pluginConfig?.DiscoveryLibraryTab === false) return false;
    // Discovery is Seerr-backed (parental-filtered + request-aware); it needs a Seerr connection.
    return JE.pluginConfig?.JellyseerrEnabled === true;
}

function ensureCss(): void {
    injectCss('je-discovery-library-css', `
        /* When the Discovery pane is active, hide the native library content (grid + A-Z rail)
           and let the shelves sit over the app backdrop — the same transparent-page look the native
           library has. #moviesPage/#tvshowsPage are already position:absolute, so the pane fills them. */
        #moviesPage.je-discovery-active > :not(.je-discovery-pane),
        #tvshowsPage.je-discovery-active > :not(.je-discovery-pane) { display: none !important; }
        .je-discovery-pane {
            position: absolute; inset: 0; z-index: 1;
            overflow-y: auto; overscroll-behavior: contain;
        }
        .je-discovery-toggle.is-active { color: var(--theme-primary-color, #00a4dc); }
    `);
}

/** The visible library page (present + not hidden) among Movies/TV, or null. */
function currentPage(): LibraryPageDef | null {
    for (const def of PAGES) {
        const el = document.querySelector<HTMLElement>(def.pageSelector);
        if (el && el.offsetParent !== null) return def;
    }
    return null;
}

function closePane(def: LibraryPageDef): void {
    const s = stateFor(def.id);
    s.pane?.destroy();
    s.pane = null;
    s.overlay?.remove();
    s.overlay = null;
    s.active = false;
    document.querySelector(def.pageSelector)?.classList.remove('je-discovery-active');
    document.getElementById('je-discovery-toggle-' + def.id)?.classList.remove('is-active');
}

function openPane(def: LibraryPageDef): void {
    const pageEl = document.querySelector<HTMLElement>(def.pageSelector);
    if (!pageEl) return;
    const s = stateFor(def.id);
    if (s.overlay) return;
    const overlay = document.createElement('div');
    overlay.className = 'je-discovery-pane';
    overlay.setAttribute('data-discovery-pane', def.id);
    const pane = createDiscoveryPane(def.mediaType, false);
    overlay.appendChild(pane.element);
    pageEl.appendChild(overlay);
    pageEl.classList.add('je-discovery-active');
    s.overlay = overlay;
    s.pane = pane;
    s.active = true;
    document.getElementById('je-discovery-toggle-' + def.id)?.classList.add('is-active');
}

function toggle(def: LibraryPageDef): void {
    const s = stateFor(def.id);
    if (s.active) closePane(def); else openPane(def);
}

/** Ensures the Discovery toggle button is in the library header tray for the given page. */
function ensureToggle(def: LibraryPageDef): void {
    const btnId = 'je-discovery-toggle-' + def.id;
    if (document.getElementById(btnId)) return;
    const headerRight = getHeaderRightContainer();
    if (!headerRight) return;
    const btn = JE.core.ui!.muiIconButton({
        id: btnId,
        icon: 'trending_up',
        title: JE.t!('discovery_tab_title'),
        className: 'headerButton headerButtonRight paper-icon-button-light je-discovery-toggle',
        onClick: () => toggle(def),
    });
    if (stateFor(def.id).active) btn.classList.add('is-active');
    headerRight.insertBefore(btn, headerRight.firstChild);
    JE.core.ui!.expandIn(btn, {});
}

/** The modern library view dropdown's item list (keepMounted), or null on the legacy layout. */
function libraryViewList(): HTMLElement | null {
    return document.querySelector<HTMLElement>('#library-view-menu ul, #library-view-menu [role="menu"]');
}

/**
 * Injects/maintains a native "Discovery" item in the modern library view dropdown for `def`.
 * Returns true when that dropdown exists (modern layout); false on legacy (use the header tray).
 */
function ensureDropdownItem(def: LibraryPageDef): boolean {
    const list = libraryViewList();
    if (!list) return false;
    const existing = list.querySelector<HTMLElement>('[data-je-discovery-item]');
    if (existing) {
        if (existing.getAttribute('data-je-discovery-item') === def.id) return true;
        existing.remove(); // stale item from the other library (Movies↔TV) — rebuild for this page
    }
    const sibling = list.querySelector<HTMLElement>('li[role="menuitem"]');
    if (!sibling) return true; // dropdown present but not yet populated — retry next tick
    const li = document.createElement('li');
    li.setAttribute('role', 'menuitem');
    li.setAttribute('tabindex', '-1');
    li.setAttribute('data-je-discovery-item', def.id);
    // Clone a real item's classes (emotion hash included) so it's pixel-identical; drop the selected state.
    li.className = sibling.className.replace(/\bMui-selected\b/g, '').replace(/\s+/g, ' ').trim();
    li.textContent = JE.t!('discovery_tab_title');
    li.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!stateFor(def.id).active) openPane(def);
        closeLibraryMenu();
    });
    list.appendChild(li);
    return true;
}

/** Closes the MUI library-view Menu so our injected item behaves like a native selection. Clicking
 *  the Modal backdrop is the reliable path (the Menu's own onClose); Escape is a fallback. */
function closeLibraryMenu(): void {
    const modal = document.querySelector<HTMLElement>('#library-view-menu')?.closest('.MuiModal-root');
    const backdrop = modal?.querySelector<HTMLElement>('.MuiBackdrop-root');
    if (backdrop) { backdrop.click(); return; }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
}

function inject(): void {
    if (!enabled()) return;
    const def = currentPage();
    // Tear down panes/toggles for any page we've navigated away from.
    for (const p of PAGES) {
        if (def && p.id === def.id) continue;
        if (stateFor(p.id).active) closePane(p);
        document.getElementById('je-discovery-toggle-' + p.id)?.remove();
    }
    if (!def) return;

    // Prefer the native dropdown item on modern; the header-tray toggle is the legacy fallback.
    // Don't show both — a modern layout has the dropdown, so the tray toggle is removed there.
    if (ensureDropdownItem(def)) {
        document.getElementById('je-discovery-toggle-' + def.id)?.remove();
    } else {
        ensureToggle(def);
    }

    // Survive React re-renders: re-assert the content-hiding class, and if the overlay node was
    // blown away, re-mount it.
    const s = stateFor(def.id);
    if (s.active) {
        const pageEl = document.querySelector<HTMLElement>(def.pageSelector);
        pageEl?.classList.add('je-discovery-active');
        if (!s.overlay || !s.overlay.isConnected) { s.pane?.destroy(); s.pane = null; s.overlay = null; openPane(def); }
    }
}

/** Closes any active Discovery pane when the user selects a native view from the library dropdown. */
function onNativeViewPicked(e: Event): void {
    const target = e.target as HTMLElement | null;
    const item = target?.closest?.('#library-view-menu li[role="menuitem"]');
    if (item && !item.hasAttribute('data-je-discovery-item')) {
        for (const p of PAGES) if (stateFor(p.id).active) closePane(p);
    }
}

function scheduleInject(): void {
    if (injectPending) return;
    injectPending = true;
    requestAnimationFrame(() => { injectPending = false; inject(); });
}

/** Wires the library-page Discovery surface. Idempotent — safe to call once at init. */
export function initLibraryTab(): void {
    ensureCss();
    JE.core.dom!.onBodyMutation('je-discovery-library', scheduleInject);
    onNavigate(scheduleInject);
    // Capture-phase so we see the native menu selection before MUI navigates it away.
    document.addEventListener('click', onNativeViewPicked, true);
    scheduleInject();
}
