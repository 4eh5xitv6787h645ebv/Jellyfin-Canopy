// src/discovery/library-tab.ts
//
// Surfaces the Discovery feed on the Movies and TV Shows library pages — the primary placement the
// user asked for, next to Suggestions/Genres/Collections. The v12 library section menu differs by
// layout: legacy is the classic emby-tabs strip; modern is a hardcoded React dropdown that crashes
// on an unknown ?tab index (LibraryPage throws on viewsByKind[type][n] === undefined). So rather
// than fake an 8th native tab, we add a "Discovery" toggle in the library header tray (the same
// zero-jank muiIconButton path native-tabs uses on modern) and, when it's on, mount the shared
// Discovery surface (pane.ts) as an overlay over the library content on the stable
// #moviesPage/#tvshowsPage div. Re-injected on navigation + a scoped body-observer tick so it
// survives React re-renders; torn down on nav away.

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
    ensureToggle(def);
    // Survive React re-renders: re-assert the content-hiding class, and if the overlay node was
    // blown away, re-mount it.
    const s = stateFor(def.id);
    if (s.active) {
        const pageEl = document.querySelector<HTMLElement>(def.pageSelector);
        pageEl?.classList.add('je-discovery-active');
        if (!s.overlay || !s.overlay.isConnected) { s.pane?.destroy(); s.pane = null; s.overlay = null; openPane(def); }
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
    scheduleInject();
}
