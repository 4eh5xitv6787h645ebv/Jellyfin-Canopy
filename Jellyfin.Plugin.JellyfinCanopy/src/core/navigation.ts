// src/core/navigation.ts
//
// Single owner of SPA navigation detection for the whole plugin.
//
// Jellyfin navigates four different ways (pushState, replaceState, hash
// change, history pop) and shows views via a 'viewshow' DOM event plus an
// Emby.Page.onViewShow router callback. Before this module existed, ~36 call
// sites wired their own hashchange/viewshow listeners, double-firing on hash
// navs and missing pushState navs entirely. This module patches history once,
// listens once, dedupes, and fans out to registered callbacks.
//
// Public surface: JC.core.navigation { routeHref, onNavigate, offNavigate,
// onViewPage, getCurrentView }. JC.helpers keeps thin aliases for unmigrated
// callers.

import { JC } from '../globals';
import type {
    JellyfinRouteParam,
    NavigateCallback,
    NavigationApi,
    ViewPageCallback,
    ViewPageOptions
} from '../types/jc';

JC.core = JC.core || {};

const logPrefix = '🪼 Jellyfin Canopy: Navigation:';

// ── Navigation events (URL changes) ─────────────────────────────────────

const navCallbacks = new Set<NavigateCallback>();

/**
 * Build an href for a Jellyfin SPA destination without assuming that the web
 * client is mounted at the origin root. A hash-only href deliberately stays
 * on the active document, which preserves reverse-proxy base paths as well as
 * the non-HTTP document origins used by native WebView clients.
 *
 * Route names are limited to Jellyfin's path-shaped route vocabulary. Query
 * names and values are encoded exactly once here so feature renderers cannot
 * accidentally turn an item id or configuration-page name into route syntax.
 */
export function routePath(
    route: string,
    params: Record<string, JellyfinRouteParam> = {}
): string {
    const normalizedRoute = route.trim().replace(/^#?\/+/, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(normalizedRoute)) {
        throw new TypeError(`Invalid Jellyfin route: ${route}`);
    }

    const query = Object.entries(params)
        .filter((entry): entry is [string, Exclude<JellyfinRouteParam, null | undefined>] =>
            entry[1] !== null && entry[1] !== undefined)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&');

    return `/${normalizedRoute}${query ? `?${query}` : ''}`;
}

/** Build a document-relative anchor for a Jellyfin SPA route. */
export function routeHref(
    route: string,
    params: Record<string, JellyfinRouteParam> = {}
): string {
    return `#${routePath(route, params)}`;
}

// Dedup guard: a hash navigation fires BOTH popstate and hashchange for
// the same URL change; on the modern layout HISTORY_UPDATE can fire twice for
// one logical nav (REPLACE normalization). Only dispatch when the canonical
// nav key actually moved. Holds the last dispatched navKey (see navDedupKey).
let lastDispatchedKey: string | null = null;

/**
 * Canonical dedup key for a navigation target.
 *
 * `pathname + search + hash` — origin is constant for the session, so this is
 * `location.href` minus the origin. Two properties matter:
 *  - It includes `search`, so param-only navigations (home tab switches,
 *    `/movies?topParentId=A→B`) produce a DIFFERENT key. That is what lets the
 *    HISTORY_UPDATE source (v12-platform.md §2) notify onNavigate for the
 *    transitions `viewshow` silently skips.
 *  - It includes `hash`, so legacy-layout hash routing (`#/home` → `#/movies`,
 *    where pathname+search stay constant) still de-duplicates correctly. On the
 *    modern layout the hash is empty, so for HISTORY_UPDATE this reduces to
 *    `pathname + search` exactly as §6.7 prescribes.
 * @param loc - A location-like with pathname/search/hash (defaults to window.location).
 */
export function navDedupKey(
    loc: { pathname: string; search: string; hash: string } = window.location
): string {
    return `${loc.pathname}${loc.search}${loc.hash}`;
}

/**
 * Patch history.pushState / history.replaceState to emit a 'jc:navigate'
 * event. Jellyfin's SPA router calls pushState for some transitions
 * without changing location.hash, so hashchange/popstate are never fired
 * for those navigations. This single patch lets all modules listen to one
 * synthetic event instead of polling.
 */
function patchNavigationEvents(): void {
    if (history.__jePushed) return; // only patch once
    history.__jePushed = true;

    const _push = history.pushState.bind(history);
    const _replace = history.replaceState.bind(history);

    // Some host pages (e.g. third-party custom-tabs plugins reacting to DOM
    // mutations) call pushState repeatedly for a URL that hasn't changed.
    // Skip the synthetic event in that case so we don't re-trigger our own
    // navigation-driven rescans, which would mutate the DOM and risk feeding
    // back into whatever observer caused the redundant pushState in the first place.
    history.pushState = function (...args: Parameters<History['pushState']>): void {
        const before = window.location.href;
        _push(...args);
        if (window.location.href !== before) {
            window.dispatchEvent(new Event('jc:navigate'));
        }
    };
    history.replaceState = function (...args: Parameters<History['replaceState']>): void {
        const before = window.location.href;
        _replace(...args);
        if (window.location.href !== before) {
            window.dispatchEvent(new Event('jc:navigate'));
        }
    };
}

/**
 * Handle the router's `HISTORY_UPDATE` signal (window.Events bus).
 *
 * This is a FIRST-CLASS navigation source, not a supplement: the v12 React
 * router captures `history.pushState` at its own module init — before our
 * bundle patches it — so param-only navigations (home tab switches, library
 * `topParentId` swaps) never fire our `jc:navigate` and never fire `viewshow`
 * either (§2/§6.2). The router DOES fire `HISTORY_UPDATE` on every such
 * transition, so wiring it here is what makes those features re-run.
 *
 * It routes through the SAME deduplicated dispatch as every other source, so:
 *  - a nav our pushState patch DID catch fires exactly once (both sources map
 *    to the same navKey; the second is swallowed), and
 *  - HISTORY_UPDATE's own double-fire (REPLACE normalization, §6.7) collapses
 *    to one dispatch because both carry the same pathname+search key.
 */
export function handleHistoryUpdate(): void {
    dispatchNavigate();
}

let historyUpdateSubscribed = false;

/**
 * Subscribe to `HISTORY_UPDATE` on the window.Events bus. Retries until the
 * bus exists (it is published at boot, but our bundle may run first).
 * @param attempt - Internal retry counter.
 */
function subscribeHistoryUpdate(attempt = 0): void {
    // The retry timer can outlive a jsdom test teardown, where `window` no
    // longer exists at all — bail instead of throwing an unhandled error.
    if (typeof window === 'undefined' || historyUpdateSubscribed) return;
    const events = window.Events;
    if (!events || typeof events.on !== 'function') {
        // Bounded retry (~5s). If the bus never appears (very old host) the
        // jc:navigate/hashchange/popstate sources still cover legacy routing.
        if (attempt < 50) {
            setTimeout(() => subscribeHistoryUpdate(attempt + 1), 100);
        }
        return;
    }
    events.on(document, 'HISTORY_UPDATE', handleHistoryUpdate);
    historyUpdateSubscribed = true;
    console.log(`${logPrefix} Subscribed to HISTORY_UPDATE (router nav signal)`);
}

/**
 * Fan a navigation event out to all subscribers, at most once per URL
 * change (popstate + hashchange pairs collapse to one dispatch).
 */
function dispatchNavigate(event?: Event): void {
    const key = navDedupKey();
    if (key === lastDispatchedKey) return;
    lastDispatchedKey = key;
    for (const callback of navCallbacks) {
        try {
            callback(event);
        } catch (err) {
            console.error(`${logPrefix} Error in onNavigate callback:`, err);
        }
    }
}

/**
 * Subscribe to all navigation events: pushState, replaceState, hashchange,
 * popstate — deduplicated so each URL change notifies exactly once.
 * @returns Unsubscribe function.
 */
export function onNavigate(callback: NavigateCallback): () => void {
    navCallbacks.add(callback);
    return () => offNavigate(callback);
}

/**
 * Remove a previously registered navigation callback.
 * @returns True if it was registered.
 */
export function offNavigate(callback: NavigateCallback): boolean {
    return navCallbacks.delete(callback);
}

// ── Pre-show view events (capture-phase viewbeforeshow) ──────────────────

type ViewBeforeShowCallback = (element: Element, event: Event) => void;

const viewBeforeShowCallbacks = new Set<ViewBeforeShowCallback>();

/**
 * Subscribe to capture-phase 'viewbeforeshow' with the incoming view element.
 * Fires before the router's bubble-phase handling (and, for React-hosted
 * views, synchronously inside their mount effect) — the only supported hook
 * for reacting to a view element before it paints. Same error isolation as
 * every other fan-out in this module.
 * @returns Unsubscribe function.
 */
export function onViewBeforeShow(callback: ViewBeforeShowCallback): () => void {
    viewBeforeShowCallbacks.add(callback);
    return () => {
        viewBeforeShowCallbacks.delete(callback);
    };
}

function dispatchViewBeforeShow(event: Event): void {
    const element = event.target;
    if (!(element instanceof Element)) return;
    for (const callback of viewBeforeShowCallbacks) {
        try {
            callback(element, event);
        } catch (err) {
            console.error(`${logPrefix} Error in onViewBeforeShow callback:`, err);
        }
    }
}

// ── View events (viewshow / Emby.Page.onViewShow) ────────────────────────

interface ViewHandlerConfig {
    callback: ViewPageCallback;
    options: { pages: string[] | null; fetchItem: boolean; immediate: boolean };
}

const viewHandlers: ViewHandlerConfig[] = [];

// Whether the Emby.Page.onViewShow override is installed. When it is, the
// host router's own document-level 'viewshow' listener forwards every view
// show into our hook, so our fallback document listener must stay silent
// to avoid double-firing handlers.
let embyHookInstalled = false;
let originalOnViewShow: ((view: string, element: Element, hash: string) => void) | null = null;

// The most recent raw 'viewshow' event, captured in the capture phase so
// it is available by the time the router's bubble-phase listener invokes
// our Emby.Page.onViewShow hook. Cleared after each notification so
// router-internal onViewShow() calls (same-path resolves) don't see a
// stale event from the previous view.
let lastViewShowEvent: CustomEvent | null = null;
// Same-tick expiry for lastViewShowEvent. A real onViewShow for the captured
// view fires synchronously in the same bubble pass, so a genuine handoff never
// needs the event to outlive the current macrotask. Anything still holding it on
// the NEXT macrotask is a different view's router-internal resolve (no preceding
// DOM viewshow) and must read `null`, not the previous view's stale event.
let lastViewShowClearTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Get item from URL hash (cached via JC.helpers when available).
 */
async function getItemFromHash(hash: string | undefined): Promise<unknown> {
    try {
        // Legacy layout: the id lives in the hash query (`#/details?id=X`).
        // Modern layout: the hash is empty and the id lives in location.search
        // (`/details?id=X`). Check the hash first, then fall back to search.
        const hashQuery = String(hash || '').split('?')[1] || '';
        let itemId = new URLSearchParams(hashQuery).get('id');
        if (!itemId && typeof window !== 'undefined' && window.location?.search) {
            itemId = new URLSearchParams(window.location.search).get('id');
        }
        if (!itemId) return null;

        if (typeof JC.helpers?.getItemCached === 'function') {
            return await JC.helpers.getItemCached(itemId);
        }
        return await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);
    } catch (err) {
        console.error(`${logPrefix} Error fetching item:`, err);
        return null;
    }
}

/**
 * Notify all registered view handlers about a view change.
 * @param view - The view name
 * @param element - The view element
 * @param hash - The URL hash
 * @param rawEvent - The raw 'viewshow' DOM event, when one triggered this.
 */
function notifyViewHandlers(
    view: string | undefined,
    element: Element | null | undefined,
    hash: string | undefined,
    rawEvent: CustomEvent | null
): void {
    viewHandlers.forEach((handlerConfig) => {
        try {
            const { callback, options } = handlerConfig;

            // Check if this handler should be called for this page
            if (options.pages && (!view || !options.pages.includes(view))) {
                return;
            }

            // Get item promise if needed
            let itemPromise: Promise<unknown> | null = null;
            if (options.fetchItem) {
                itemPromise = getItemFromHash(hash);
            }

            // Call the handler
            callback(view, element, hash, itemPromise, rawEvent);
        } catch (err) {
            console.error(`${logPrefix} Error in view handler:`, err);
        }
    });
}

/**
 * Register a callback to be called when a page view is shown.
 * @param callback - Called with (view, element, hash, itemPromise, rawEvent)
 * @param options - Options for the handler
 * @returns Unregister function
 */
export function onViewPage(callback: ViewPageCallback, options: ViewPageOptions = {}): () => void {
    const handlerConfig: ViewHandlerConfig = {
        callback,
        options: {
            pages: options.pages || null,
            fetchItem: options.fetchItem || false,
            immediate: options.immediate || false
        }
    };

    viewHandlers.push(handlerConfig);

    // Call immediately if requested and we're on a matching page
    if (options.immediate) {
        try {
            const currentView = getCurrentView();
            const currentHash = window.location.hash;

            if (!options.pages || (currentView && options.pages.includes(currentView))) {
                const element = document.querySelector('.libraryPage:not(.hide)');
                let itemPromise: Promise<unknown> | null = null;
                if (options.fetchItem) {
                    itemPromise = getItemFromHash(currentHash);
                }
                callback(currentView, element, currentHash, itemPromise, null);
            }
        } catch (err) {
            console.error(`${logPrefix} Error in immediate handler call:`, err);
        }
    }

    // Return unregister function
    return () => {
        const index = viewHandlers.indexOf(handlerConfig);
        if (index !== -1) {
            viewHandlers.splice(index, 1);
        }
    };
}

/**
 * Get current view name.
 */
export function getCurrentView(): string | null {
    const visiblePage = document.querySelector<HTMLElement>('.libraryPage:not(.hide)');
    if (!visiblePage) return null;

    // Try to get view from data attributes or id
    return visiblePage.dataset.type ||
        visiblePage.id ||
        visiblePage.getAttribute('data-role') ||
        null;
}

/**
 * Hook into Emby.Page.onViewShow. Retries (bounded) until the host router exists.
 * Exported for the retry-cap unit test.
 * @param attempt - Internal retry counter.
 */
export function installEmbyHook(attempt = 0): void {
    // The retry timer can outlive a jsdom test teardown, where `window` no
    // longer exists at all — bail instead of throwing an unhandled error
    // (mirrors subscribeHistoryUpdate).
    if (typeof window === 'undefined') return;
    if (!window.Emby?.Page) {
        // Bounded retry (~5s). If Emby.Page never appears, the
        // jc:navigate/hashchange/popstate/HISTORY_UPDATE sources still cover routing.
        if (attempt < 50) {
            setTimeout(() => installEmbyHook(attempt + 1), 100);
        }
        return;
    }

    const page = window.Emby.Page as {
        onViewShow?: (view: string, element: Element, hash: string) => void;
    };
    originalOnViewShow = page.onViewShow ?? null;

    page.onViewShow = function (this: unknown, view: string, element: Element, hash: string): void {
        // Call original handler first
        if (originalOnViewShow) {
            try {
                originalOnViewShow.call(this, view, element, hash);
            } catch (err) {
                console.warn(`${logPrefix} Error in original onViewShow:`, err);
            }
        }

        const rawEvent = lastViewShowEvent;
        lastViewShowEvent = null;
        if (lastViewShowClearTimer) {
            clearTimeout(lastViewShowClearTimer);
            lastViewShowClearTimer = null;
        }
        notifyViewHandlers(view, element, hash, rawEvent);
    };

    embyHookInstalled = true;
    console.log(`${logPrefix} Hooked into Emby.Page.onViewShow`);
}

function initialize(): void {
    // Capture the raw viewshow event before the router's bubble-phase
    // listener forwards the show into our Emby.Page hook. Schedule a same-tick
    // expiry so a router-internal onViewShow that fires WITHOUT a preceding
    // viewshow (a later same-path resolve) can never consume this event.
    document.addEventListener('viewshow', (e) => {
        lastViewShowEvent = e as CustomEvent;
        if (lastViewShowClearTimer) clearTimeout(lastViewShowClearTimer);
        lastViewShowClearTimer = setTimeout(() => {
            lastViewShowEvent = null;
            lastViewShowClearTimer = null;
        }, 0);
    }, true);

    // Pre-show hook for subscribers that must act before the view paints
    // (page adoption). Capture phase so it precedes every bubble listener.
    document.addEventListener('viewbeforeshow', dispatchViewBeforeShow, true);

    // Fallback for hosts where Emby.Page never appears: drive view
    // handlers straight from the DOM event. Silent while the hook is
    // installed — the router already forwards those into the hook.
    document.addEventListener('viewshow', (e) => {
        if (embyHookInstalled) return;
        const rawEvent = e as CustomEvent<{ view?: Element } | undefined>;
        lastViewShowEvent = null;
        if (lastViewShowClearTimer) {
            clearTimeout(lastViewShowClearTimer);
            lastViewShowClearTimer = null;
        }
        notifyViewHandlers(getCurrentView() || undefined, rawEvent.detail?.view || null, window.location.hash, rawEvent);
    });

    // Navigation sources → single deduplicated dispatch.
    // jc:navigate (our pushState patch) + hashchange/popstate cover legacy
    // routing and any nav our patch catches; HISTORY_UPDATE (subscribed below)
    // is the universal signal for the modern router's param-only navs.
    window.addEventListener('jc:navigate', dispatchNavigate);
    window.addEventListener('hashchange', dispatchNavigate);
    window.addEventListener('popstate', dispatchNavigate);

    patchNavigationEvents();
    subscribeHistoryUpdate();
    installEmbyHook();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
} else {
    initialize();
}

const navigation: NavigationApi = {
    routeHref,
    onNavigate,
    offNavigate,
    onViewPage,
    onViewBeforeShow,
    getCurrentView,
    /** @returns Number of registered onViewPage handlers. */
    getViewHandlerCount: () => viewHandlers.length,
    /** @returns Number of registered onNavigate callbacks. */
    getNavCallbackCount: () => navCallbacks.size
};

JC.core.navigation = navigation;

console.log(`${logPrefix} initialized`);
