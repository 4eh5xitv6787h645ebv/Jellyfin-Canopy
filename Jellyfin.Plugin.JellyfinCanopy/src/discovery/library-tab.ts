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
import {
    type CurrentViewRoot,
    navDedupKey,
    onNavigate,
    onViewPage,
    queryElementsById,
    recordViewRootShown,
    resolveCurrentViewRoot,
} from '../core/navigation';
import { getHeaderRightContainer } from '../enhanced/helpers';
import { injectCss } from '../core/ui-kit';
import type { DiscoveryMediaType } from './rows';
import { renderFeed, type DiscoveryFeedHandle } from './feed';
import { fetchGenres } from './data';
import { getUserRowIds } from './prefs';
import { openCustomize } from './customize';
import type { IdentityContext, LifecycleHandle } from '../types/jc';

interface LibraryPageDef {
    id: string;
    pageId: string;
    mediaType: DiscoveryMediaType;
}

const PAGES: LibraryPageDef[] = [
    { id: 'movies', pageId: 'moviesPage', mediaType: 'movie' },
    { id: 'tvshows', pageId: 'tvshowsPage', mediaType: 'tv' },
];

interface PageView {
    def: LibraryPageDef;
    current: CurrentViewRoot;
}

interface PaneOwner {
    readonly root: HTMLElement;
    readonly navigationKey: string;
    readonly showSequence: number;
    readonly context: IdentityContext;
    readonly epoch: number;
    readonly generation: number;
    readonly abortController: AbortController;
    pane: HTMLElement;
    feedHost: HTMLElement;
    feed: DiscoveryFeedHandle | null;
    feedController: AbortController | null;
    pendingController: AbortController | null;
    renderGeneration: number;
    customizeController: AbortController | null;
    customizeClose: (() => void) | null;
}

interface PaneState {
    active: boolean;
    generation: number;
    owner: PaneOwner | null;
    toggle: HTMLButtonElement | null;
    toggleRoot: HTMLElement | null;
    toggleNavigationKey: string | null;
    toggleShowSequence: number;
}

const state = new Map<string, PaneState>();
let injectPending = false;
let injectFrame: number | null = null;
let initialized = false;
let activeContext: IdentityContext | null = null;
let lifecycle: LifecycleHandle | null = null;

function stateFor(id: string): PaneState {
    let s = state.get(id);
    if (!s) {
        s = {
            active: false,
            generation: 0,
            owner: null,
            toggle: null,
            toggleRoot: null,
            toggleNavigationKey: null,
            toggleShowSequence: 0,
        };
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

function currentRoot(def: LibraryPageDef): CurrentViewRoot | null {
    return resolveCurrentViewRoot(def.pageId);
}

function libraryRouteId(navigationKey: string): string | null {
    const hashRoute = navigationKey.indexOf('#/');
    const rawPath = hashRoute >= 0
        ? navigationKey.slice(hashRoute + 2)
        : navigationKey.split('#', 1)[0];
    const leaf = rawPath.split(/[?#]/, 1)[0]
        .split('/')
        .filter(Boolean)
        .at(-1)
        ?.replace(/\.html$/i, '')
        .toLowerCase();
    return leaf === 'movies' || leaf === 'tvshows' ? leaf : null;
}

function isVisibleConnectedRoot(root: HTMLElement): boolean {
    if (!root.isConnected || root.hidden) return false;
    if (root.getAttribute('aria-hidden') === 'true') return false;
    return root.closest('.hide, [hidden], [aria-hidden="true"]') === null;
}

/**
 * Library query switches change the navigation key but intentionally reuse the
 * same React root and fire no view lifecycle event. Carry only an exact prior
 * Movie/TV owner when the route kind is unchanged and it remains the sole
 * visible instance; full route transitions continue to wait for viewshow.
 */
function carryRootAcrossParamNavigation(): void {
    const currentNavigationKey = navDedupKey();
    const routeId = libraryRouteId(currentNavigationKey);
    if (!routeId) return;
    const def = PAGES.find((candidate) => candidate.id === routeId);
    const s = state.get(routeId);
    if (!def || !s) return;
    const root = s.owner?.root ?? s.toggleRoot;
    const previousNavigationKey = s.owner?.navigationKey ?? s.toggleNavigationKey;
    if (!root || !previousNavigationKey || previousNavigationKey === currentNavigationKey) return;
    if (libraryRouteId(previousNavigationKey) !== routeId) return;
    const visibleRoots = queryElementsById(def.pageId).filter(isVisibleConnectedRoot);
    if (visibleRoots.length !== 1 || visibleRoots[0] !== root) return;
    recordViewRootShown(root);
}

/** The exact visible library page instance among cached Movies/TV roots, or null. */
function currentPage(): PageView | null {
    for (const def of PAGES) {
        const current = currentRoot(def);
        if (current) return { def, current };
    }
    return null;
}

function removeToggle(s: PaneState): void {
    s.toggle?.remove();
    s.toggle = null;
    s.toggleRoot = null;
    s.toggleNavigationKey = null;
    s.toggleShowSequence = 0;
}

function retireOwner(s: PaneState, owner: PaneOwner): void {
    if (s.owner !== owner) return;
    s.owner = null;
    owner.abortController.abort();
    owner.pendingController?.abort();
    owner.pendingController = null;
    owner.customizeController?.abort();
    owner.customizeController = null;
    owner.customizeClose?.();
    owner.customizeClose = null;
    owner.feedController?.abort();
    owner.feedController = null;
    owner.feed?.destroy();
    owner.feed = null;
    owner.pane.remove();
    owner.root.classList.remove('jc-discovery-active');
}

function closePane(def: LibraryPageDef): void {
    const s = stateFor(def.id);
    s.active = false;
    s.generation += 1;
    if (s.owner) retireOwner(s, s.owner);
    s.toggle?.classList.remove('is-active');
}

function ownerIsCurrent(def: LibraryPageDef, s: PaneState, owner: PaneOwner): boolean {
    const current = currentRoot(def);
    return state.get(def.id) === s
        && s.owner === owner
        && s.active
        && s.generation === owner.generation
        && owner.epoch === owner.context.epoch
        && JC.identity.isCurrent(owner.context)
        && owner.root.isConnected
        && owner.pane.isConnected
        && current?.root === owner.root
        && current.navigationKey === owner.navigationKey
        && current.showSequence === owner.showSequence;
}

/**
 * (Re)renders the feed using the caller's current saved row prefs. Build into a detached staging
 * host and swap only after the new feed is complete, so a config push never blanks the current
 * explicit-empty/default view while genres and row state are being resolved.
 */
async function renderFeedHost(def: LibraryPageDef, s: PaneState, owner: PaneOwner): Promise<void> {
    if (!ownerIsCurrent(def, s, owner)) return;
    owner.pendingController?.abort();
    const controller = new AbortController();
    owner.pendingController = controller;
    const generation = ++owner.renderGeneration;
    const stagingHost = document.createElement('div');
    const abortPending = (): void => controller.abort();
    owner.abortController.signal.addEventListener('abort', abortPending, { once: true });
    let handle: DiscoveryFeedHandle;
    try {
        handle = await renderFeed(
            stagingHost,
            def.mediaType,
            getUserRowIds(def.mediaType),
            {
                signal: controller.signal,
                isCurrent: () => ownerIsCurrent(def, s, owner)
                    && (owner.pendingController === controller || owner.feedController === controller),
            }
        );
    } catch (error) {
        const wasAborted = controller.signal.aborted;
        controller.abort();
        if (!wasAborted && ownerIsCurrent(def, s, owner)) {
            console.warn('🪼 Jellyfin Canopy: Discovery feed render failed:', error);
        }
        if (owner.pendingController === controller) owner.pendingController = null;
        return;
    } finally {
        owner.abortController.signal.removeEventListener('abort', abortPending);
    }
    if (!ownerIsCurrent(def, s, owner)
        || controller.signal.aborted
        || owner.pendingController !== controller
        || owner.renderGeneration !== generation) {
        controller.abort();
        handle.destroy();
        if (owner.pendingController === controller) owner.pendingController = null;
        return;
    }
    const previous = owner.feed;
    const previousController = owner.feedController;
    owner.feedHost.replaceChildren(...Array.from(stagingHost.childNodes));
    owner.feed = handle;
    owner.feedController = controller;
    owner.pendingController = null;
    previousController?.abort();
    previous?.destroy();
}

/** Builds the pane toolbar with the per-user "Customize" button. */
function buildToolbar(def: LibraryPageDef, s: PaneState, owner: PaneOwner): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'jc-discovery-toolbar';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'jc-discovery-customize-btn';
    JC.identity.own(btn, owner.context);
    const icon = document.createElement('span');
    icon.className = 'material-icons';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'tune';
    const lbl = document.createElement('span');
    lbl.textContent = JC.t!('discovery_customize_button');
    btn.append(icon, lbl);
    btn.addEventListener('click', () => {
        if (!ownerIsCurrent(def, s, owner)) return;
        owner.customizeController?.abort();
        owner.customizeClose?.();
        owner.customizeClose = null;
        const controller = new AbortController();
        owner.customizeController = controller;
        void fetchGenres(def.mediaType, controller.signal).then((genres) => {
            if (!ownerIsCurrent(def, s, owner)
                || controller.signal.aborted
                || owner.customizeController !== controller
                || !btn.isConnected) return;
            let closeHandle: (() => void) | null = null;
            closeHandle = openCustomize(
                def.mediaType,
                genres,
                () => {
                    if (ownerIsCurrent(def, s, owner)) void renderFeedHost(def, s, owner);
                },
                () => {
                    if (owner.customizeClose === closeHandle) owner.customizeClose = null;
                }
            );
            owner.customizeClose = closeHandle;
        }).finally(() => {
            if (owner.customizeController === controller) owner.customizeController = null;
        });
    });
    toolbar.appendChild(btn);
    return toolbar;
}

function openPane(def: LibraryPageDef, current: CurrentViewRoot, context: IdentityContext): void {
    const resolved = currentRoot(def);
    if (!JC.identity.isCurrent(context)
        || resolved?.root !== current.root
        || resolved.navigationKey !== current.navigationKey
        || resolved.showSequence !== current.showSequence) return;
    const root = current.root;
    const s = stateFor(def.id);
    if (s.owner && s.owner.root === root && ownerIsCurrent(def, s, s.owner)) return;
    if (s.owner) retireOwner(s, s.owner);
    s.active = true;
    const generation = ++s.generation;
    const pane = document.createElement('div');
    pane.className = 'jc-discovery-pane';
    pane.setAttribute('data-discovery-pane', def.id);
    pane.setAttribute('data-jc-identity-owned', 'true');
    JC.identity.own(pane, context);
    const feedHost = document.createElement('div');
    const owner: PaneOwner = {
        root,
        navigationKey: current.navigationKey,
        showSequence: current.showSequence,
        context,
        epoch: context.epoch,
        generation,
        abortController: new AbortController(),
        pane,
        feedHost,
        feed: null,
        feedController: null,
        pendingController: null,
        renderGeneration: 0,
        customizeController: null,
        customizeClose: null,
    };
    pane.append(buildToolbar(def, s, owner), feedHost);
    root.appendChild(pane);
    root.classList.add('jc-discovery-active');
    s.owner = owner;
    s.toggle?.classList.add('is-active');
    void renderFeedHost(def, s, owner);
}

function toggle(def: LibraryPageDef, current: CurrentViewRoot, context: IdentityContext): void {
    const resolved = currentRoot(def);
    if (!JC.identity.isCurrent(context)
        || resolved?.root !== current.root
        || resolved.navigationKey !== current.navigationKey
        || resolved.showSequence !== current.showSequence) return;
    const s = stateFor(def.id);
    if (s.active) closePane(def); else openPane(def, current, context);
}

/** Ensures the Discovery toggle button is in the library header tray for the given page. */
function ensureToggle(def: LibraryPageDef, current: CurrentViewRoot, context: IdentityContext): void {
    if (!JC.identity.isCurrent(context)) return;
    const s = stateFor(def.id);
    if (s.toggle?.isConnected
        && s.toggleRoot === current.root
        && s.toggleNavigationKey === current.navigationKey
        && s.toggleShowSequence === current.showSequence) {
        s.toggle.classList.toggle('is-active', s.active);
        return;
    }
    removeToggle(s);
    const btnId = 'jc-discovery-toggle-' + def.id;
    const headerRight = getHeaderRightContainer();
    if (!headerRight) return;
    queryElementsById(btnId).forEach((button) => button.remove());
    const btn = JC.core.ui!.muiIconButton({
        id: btnId,
        icon: 'trending_up',
        title: JC.t!('discovery_tab_title'),
        className: 'headerButton headerButtonRight paper-icon-button-light jc-discovery-toggle',
        onClick: () => toggle(def, current, context),
    });
    btn.setAttribute('data-jc-identity-owned', 'true');
    JC.identity.own(btn, context);
    if (s.active) btn.classList.add('is-active');
    headerRight.insertBefore(btn, headerRight.firstChild);
    s.toggle = btn;
    s.toggleRoot = current.root;
    s.toggleNavigationKey = current.navigationKey;
    s.toggleShowSequence = current.showSequence;
    JC.core.ui!.expandIn(btn, {});
}

function inject(context: IdentityContext): void {
    if (!JC.identity.isCurrent(context)) return;
    if (!enabled()) return;
    const view = currentPage();
    // Tear down panes/toggles for any page we've navigated away from.
    for (const p of PAGES) {
        if (view && p.id === view.def.id) continue;
        const s = stateFor(p.id);
        if (s.active || s.owner) closePane(p);
        removeToggle(s);
    }
    if (!view) return;
    const { def, current } = view;
    const root = current.root;
    const s = stateFor(def.id);
    ensureToggle(def, current, context);
    // Survive React re-renders: re-assert the content-hiding class, and if the pane node was blown
    // away, re-mount it.
    if (s.active) {
        const owner = s.owner;
        if (!owner || !ownerIsCurrent(def, s, owner)) {
            if (owner) retireOwner(s, owner);
            openPane(def, current, context);
        } else {
            root.classList.add('jc-discovery-active');
        }
    } else if (s.owner) {
        retireOwner(s, s.owner);
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
            const s = stateFor(def.id);
            if (s.active || s.owner) closePane(def);
            removeToggle(s);
        }
        return;
    }
    for (const def of PAGES) {
        const s = stateFor(def.id);
        if (s.owner && ownerIsCurrent(def, s, s.owner)) void renderFeedHost(def, s, s.owner);
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
    lifecycle = JC.core.lifecycle!.register('discovery-library-tab');
    ensureCss();
    lifecycle.track(JC.core.dom!.onBodyMutation('jc-discovery-library', () => scheduleInject(context)));
    lifecycle.track(onNavigate(() => {
        carryRootAcrossParamNavigation();
        scheduleInject(context);
    }));
    lifecycle.track(onViewPage(() => scheduleInject(context)));
    lifecycle.addListener(window, 'jc:config-changed', handleConfigChanged);
    scheduleInject(context);
}

export function resetLibraryTab(): void {
    if (injectFrame !== null) cancelAnimationFrame(injectFrame);
    injectFrame = null;
    injectPending = false;
    lifecycle?.teardown();
    lifecycle = null;
    for (const def of PAGES) {
        closePane(def);
        removeToggle(stateFor(def.id));
    }
    state.clear();
    document.querySelectorAll('.jc-discovery-pane, .jc-discovery-toggle').forEach((node) => node.remove());
    document.querySelectorAll('#moviesPage.jc-discovery-active, #tvshowsPage.jc-discovery-active')
        .forEach((node) => node.classList.remove('jc-discovery-active'));
    activeContext = null;
    initialized = false;
}
