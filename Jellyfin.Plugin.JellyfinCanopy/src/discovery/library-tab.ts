// src/discovery/library-tab.ts
//
// Surfaces the Discovery feed on the Movies and TV Shows library pages — the primary placement the
// user asked for, next to Suggestions/Genres/Collections. The v12 library section menu differs by
// layout: legacy is the classic emby-tabs strip; modern is a hardcoded React dropdown that crashes
// on an unknown ?tab index (LibraryPage throws on viewsByKind[type][n] === undefined). So rather
// than fake an 8th native tab, we add a "Discovery" toggle in the library header tray (the same
// zero-jank muiIconButton path native-tabs uses on modern) and, when it's on, mount the feed as an
// overlay pane over the library content on the stable #moviesPage/#tvshowsPage div. Re-injected on
// navigation + a scoped body-observer tick so it survives React re-renders; torn down on nav away.

import { JC } from '../globals';
import { onNavigate } from '../core/navigation';
import { getHeaderRightContainer } from '../enhanced/helpers';
import { injectCss } from '../core/ui-kit';
import type { DiscoveryMediaType } from './rows';
import { renderFeed, type DiscoveryFeedHandle } from './feed';
import { fetchGenres } from './data';
import { getUserRowIds } from './prefs';
import { openCustomize } from './customize';
import type { IdentityContext } from '../types/jc';

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
    feed: DiscoveryFeedHandle | null;
    pane: HTMLElement | null;
    feedHost: HTMLElement | null;
    renderGeneration: number;
}

const state = new Map<string, PaneState>();
let injectPending = false;
let injectFrame: number | null = null;
let initialized = false;
let activeContext: IdentityContext | null = null;
const lifecycle = JC.core.lifecycle!.register('discovery-library-tab');

function stateFor(id: string): PaneState {
    let s = state.get(id);
    if (!s) {
        s = { active: false, feed: null, pane: null, feedHost: null, renderGeneration: 0 };
        state.set(id, s);
    }
    return s;
}

function enabled(): boolean {
    if (JC.pluginConfig?.DiscoveryEnabled === false) return false;
    if (JC.pluginConfig?.DiscoveryLibraryTab === false) return false;
    // Discovery is Seerr-backed (parental-filtered + request-aware); it needs a Seerr connection.
    return JC.pluginConfig?.SeerrEnabled === true;
}

function ensureCss(): void {
    injectCss('jc-discovery-library-css', `
        /* When the Discovery pane is active, hide the native library content (grid + A-Z rail)
           and let the shelves sit over the app backdrop — the same transparent-page look the native
           library has. #moviesPage/#tvshowsPage are already position:absolute, so the pane fills them. */
        #moviesPage.jc-discovery-active > :not(.jc-discovery-pane),
        #tvshowsPage.jc-discovery-active > :not(.jc-discovery-pane) { display: none !important; }
        .jc-discovery-pane {
            position: absolute; inset: 0; z-index: 1;
            overflow-y: auto; overscroll-behavior: contain;
        }
        .jc-discovery-toggle.is-active { color: var(--theme-primary-color, #00a4dc); }
        .jc-discovery-toolbar { display: flex; justify-content: flex-end; padding: 0.4em 1.2em 0; }
        .jc-discovery-customize-btn {
            display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
            background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14);
            color: rgba(255,255,255,0.85); border-radius: 6px; padding: 5px 12px; font-size: 13px;
        }
        .jc-discovery-customize-btn:hover { background: rgba(255,255,255,0.14); }
        .jc-discovery-customize-btn .material-icons { font-size: 16px; }
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
    s.renderGeneration += 1;
    s.feed?.destroy();
    s.feed = null;
    s.pane?.remove();
    s.pane = null;
    s.feedHost = null;
    s.active = false;
    document.querySelector(def.pageSelector)?.classList.remove('jc-discovery-active');
    document.getElementById('jc-discovery-toggle-' + def.id)?.classList.remove('is-active');
}

/**
 * (Re)renders the feed using the caller's current saved row prefs. Build into a detached staging
 * host and swap only after the new feed is complete, so a config push never blanks the current
 * explicit-empty/default view while genres and row state are being resolved.
 */
async function renderFeedHost(def: LibraryPageDef, context: IdentityContext): Promise<void> {
    if (!JC.identity.isCurrent(context)) return;
    const s = stateFor(def.id);
    if (!s.feedHost) return;
    const feedHost = s.feedHost;
    const generation = ++s.renderGeneration;
    const stagingHost = document.createElement('div');
    const handle = await renderFeed(stagingHost, def.mediaType, getUserRowIds(def.mediaType));
    if (!JC.identity.isCurrent(context)
        || state.get(def.id) !== s
        || !s.active
        || s.feedHost !== feedHost
        || s.renderGeneration !== generation) {
        handle.destroy();
        return;
    }
    const previous = s.feed;
    feedHost.replaceChildren(...Array.from(stagingHost.childNodes));
    s.feed = handle;
    previous?.destroy();
}

/** Builds the pane toolbar with the per-user "Customize" button. */
function buildToolbar(def: LibraryPageDef, context: IdentityContext): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'jc-discovery-toolbar';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'jc-discovery-customize-btn';
    JC.identity.own(btn, context);
    const icon = document.createElement('span');
    icon.className = 'material-icons';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'tune';
    const lbl = document.createElement('span');
    lbl.textContent = JC.t!('discovery_customize_button');
    btn.append(icon, lbl);
    btn.addEventListener('click', () => {
        if (!JC.identity.isCurrent(context)) return;
        void fetchGenres(def.mediaType).then((genres) => {
            if (!JC.identity.isCurrent(context) || !btn.isConnected) return;
            openCustomize(def.mediaType, genres, () => {
                if (JC.identity.isCurrent(context)) void renderFeedHost(def, context);
            });
        });
    });
    toolbar.appendChild(btn);
    return toolbar;
}

async function openPane(def: LibraryPageDef, context: IdentityContext): Promise<void> {
    if (!JC.identity.isCurrent(context)) return;
    const pageEl = document.querySelector<HTMLElement>(def.pageSelector);
    if (!pageEl) return;
    const s = stateFor(def.id);
    if (s.pane) return;
    const pane = document.createElement('div');
    pane.className = 'jc-discovery-pane';
    pane.setAttribute('data-discovery-pane', def.id);
    pane.setAttribute('data-jc-identity-owned', 'true');
    JC.identity.own(pane, context);
    const feedHost = document.createElement('div');
    pane.append(buildToolbar(def, context), feedHost);
    pageEl.appendChild(pane);
    pageEl.classList.add('jc-discovery-active');
    s.pane = pane;
    s.feedHost = feedHost;
    s.active = true;
    document.getElementById('jc-discovery-toggle-' + def.id)?.classList.add('is-active');
    await renderFeedHost(def, context);
    // If we were torn down mid-render (nav away), discard the now-orphaned pane.
    if (!JC.identity.isCurrent(context) || state.get(def.id) !== s || !s.active) {
        s.feed?.destroy();
        s.feed = null;
        pane.remove();
        if (state.get(def.id) === s) {
            s.pane = null;
            s.feedHost = null;
        }
    }
}

function toggle(def: LibraryPageDef, context: IdentityContext): void {
    if (!JC.identity.isCurrent(context)) return;
    const s = stateFor(def.id);
    if (s.active) closePane(def); else void openPane(def, context);
}

/** Ensures the Discovery toggle button is in the library header tray for the given page. */
function ensureToggle(def: LibraryPageDef, context: IdentityContext): void {
    if (!JC.identity.isCurrent(context)) return;
    const btnId = 'jc-discovery-toggle-' + def.id;
    if (document.getElementById(btnId)) return;
    const headerRight = getHeaderRightContainer();
    if (!headerRight) return;
    const btn = JC.core.ui!.muiIconButton({
        id: btnId,
        icon: 'trending_up',
        title: JC.t!('discovery_tab_title'),
        className: 'headerButton headerButtonRight paper-icon-button-light jc-discovery-toggle',
        onClick: () => toggle(def, context),
    });
    btn.setAttribute('data-jc-identity-owned', 'true');
    JC.identity.own(btn, context);
    if (stateFor(def.id).active) btn.classList.add('is-active');
    headerRight.insertBefore(btn, headerRight.firstChild);
    JC.core.ui!.expandIn(btn, {});
}

function inject(context: IdentityContext): void {
    if (!JC.identity.isCurrent(context)) return;
    if (!enabled()) return;
    const def = currentPage();
    // Tear down panes/toggles for any page we've navigated away from.
    for (const p of PAGES) {
        if (def && p.id === def.id) continue;
        if (stateFor(p.id).active) closePane(p);
        document.getElementById('jc-discovery-toggle-' + p.id)?.remove();
    }
    if (!def) return;
    ensureToggle(def, context);
    // Survive React re-renders: re-assert the content-hiding class, and if the pane node was blown
    // away, re-mount it.
    const s = stateFor(def.id);
    if (s.active) {
        const pageEl = document.querySelector<HTMLElement>(def.pageSelector);
        pageEl?.classList.add('jc-discovery-active');
        if (!s.pane || !s.pane.isConnected) { s.pane = null; void openPane(def, context); }
    }
}

function scheduleInject(context: IdentityContext | null = activeContext): void {
    if (!context || !JC.identity.isCurrent(context)) return;
    if (injectPending) return;
    injectPending = true;
    injectFrame = requestAnimationFrame(() => {
        injectFrame = null;
        injectPending = false;
        if (JC.identity.isCurrent(context)) inject(context);
    });
}

function handleConfigChanged(): void {
    const context = activeContext;
    if (!context || !JC.identity.isCurrent(context)) return;
    if (!enabled()) {
        for (const def of PAGES) {
            if (stateFor(def.id).active) closePane(def);
            document.getElementById('jc-discovery-toggle-' + def.id)?.remove();
        }
        return;
    }
    for (const def of PAGES) {
        if (stateFor(def.id).active) void renderFeedHost(def, context);
    }
    scheduleInject(context);
}

/** Wires the library-page Discovery surface. Idempotent — safe to call once at init. */
export function initLibraryTab(): void {
    if (initialized) return;
    const context = JC.identity.capture();
    if (!context) return;
    initialized = true;
    activeContext = context;
    ensureCss();
    lifecycle.track(JC.core.dom!.onBodyMutation('jc-discovery-library', () => scheduleInject(context)));
    lifecycle.track(onNavigate(() => scheduleInject(context)));
    lifecycle.addListener(window, 'jc:config-changed', handleConfigChanged);
    scheduleInject(context);
}

function resetLibraryTab(): void {
    if (injectFrame !== null) cancelAnimationFrame(injectFrame);
    injectFrame = null;
    injectPending = false;
    lifecycle.teardown();
    for (const def of PAGES) closePane(def);
    state.clear();
    document.querySelectorAll('.jc-discovery-pane, .jc-discovery-toggle').forEach((node) => node.remove());
    document.querySelectorAll('#moviesPage.jc-discovery-active, #tvshowsPage.jc-discovery-active')
        .forEach((node) => node.classList.remove('jc-discovery-active'));
    activeContext = null;
    initialized = false;
}

JC.identity.registerReset('discovery-library-tab', resetLibraryTab);
JC.identity.registerActivate('discovery-library-tab', () => initLibraryTab());
