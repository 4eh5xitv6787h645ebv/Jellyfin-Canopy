// src/enhanced/helpers.ts
//
// Centralized helper utilities for Jellyfin Canopy.
// (Converted from js/enhanced/helpers.js — bodies semantically identical.)
//
// The navigation, DOM-observer and CSS/escaping primitives that used to live
// here moved to src/core/ (navigation.ts, dom-observer.ts, ui-kit.ts).
// JC.helpers keeps thin aliases so unmigrated callers work unchanged; new
// code should use JC.core.* directly (or import from src/core / this module).

import { JC } from '../globals';
import { onNavigate } from '../core/navigation';
import type { IdentityContext, NavigateCallback, ViewPageCallback, ViewPageOptions } from '../types/jc';

// Tracks whether the MUI-toolbar button-sizing CSS fix has been injected (see
// getHeaderRightContainer below) so it's only added once.
let muiHeaderButtonCSSInjected = false;

// PERF(R4): per-navigation cache for getHeaderRightContainer. Resolving the
// container reads legacy.offsetParent — a forced layout read — and callers
// (keyed injectors, observer ticks) may probe many times per second while
// content streams in. Cache the successful resolution and invalidate on
// navigation so layout is read at most once per nav, not per tick.
let cachedHeaderRightContainer: HTMLElement | null = null;
onNavigate(() => { cachedHeaderRightContainer = null; });

interface ItemCacheEntry {
    item: unknown;
    ts: number;
    promise: Promise<unknown> | null;
    owner: IdentityContext;
    userId: string;
    itemId: string;
}

// Shared cache for item payloads to deduplicate cross-module ApiClient.getItem calls
const itemCache = new Map<string, ItemCacheEntry>();
const ITEM_CACHE_TTL_MS = 30000; // 30s -- long enough for batch prefetch to warm cache before tag systems scan

/**
 * Drop short-lived native item DTOs for one account (or every account).
 * Privacy-policy/watch-state transitions call this before a global tag reset so
 * a failed tag-data request cannot fall back to a pre-transition DTO.
 */
export function clearItemCache(userId?: string, itemIds?: string[]): void {
    if (!userId) {
        itemCache.clear();
        return;
    }
    const normalizedUserId = userId.replace(/-/g, '').toLowerCase();
    const selected = itemIds && itemIds.length > 0
        ? new Set(itemIds.map((id) => id.replace(/-/g, '').toLowerCase()))
        : null;
    for (const [key, entry] of itemCache) {
        if (entry.userId !== normalizedUserId) continue;
        if (!selected || selected.has(entry.itemId)) itemCache.delete(key);
    }
}

export interface GetItemCachedOptions {
    userId?: string;
    ttlMs?: number;
    forceRefresh?: boolean;
}

/**
 * Deduplicated item fetch with short TTL cache.
 * Prevents multiple modules from requesting the same item concurrently on detail page navigation.
 */
export async function getItemCached(itemId: string, options: GetItemCachedOptions = {}): Promise<unknown> {
    if (!itemId) return null;

    const context = JC.identity.capture();
    if (!context) return null;
    const ttlMs = Number.isFinite(options.ttlMs) ? (options.ttlMs as number) : ITEM_CACHE_TTL_MS;
    const userId = options.userId || ApiClient.getCurrentUserId();
    const normalizedUserId = String(userId).replace(/-/g, '').toLowerCase();
    const normalizedItemId = itemId.replace(/-/g, '').toLowerCase();
    const key = `${context.serverId}:${normalizedUserId}:${normalizedItemId}`;
    const now = Date.now();
    const entry = itemCache.get(key);

    if (!options.forceRefresh && entry && JC.identity.isCurrent(entry.owner)) {
        if (entry.promise) {
            return entry.promise;
        }
        if (entry.item && (now - entry.ts) < ttlMs) {
            return entry.item;
        }
    }

    const promise = ApiClient.getItem(userId, itemId)
        .then((item) => {
            if (!JC.identity.isCurrent(context)) return null;
            // A privacy reset or newer forced fetch may retire this request while
            // it is in flight. Only the promise that still owns the key may publish.
            if (itemCache.get(key)?.promise === promise) {
                itemCache.set(key, {
                    item,
                    ts: Date.now(),
                    promise: null,
                    owner: context,
                    userId: normalizedUserId,
                    itemId: normalizedItemId
                });
            }
            return item;
        })
        .catch((err: unknown) => {
            // Likewise, an older rejection must not delete a newer request/value.
            if (itemCache.get(key)?.promise === promise) itemCache.delete(key);
            if (!JC.identity.isCurrent(context)) return null;
            throw err;
        });

    itemCache.set(key, {
        item: null,
        ts: now,
        promise,
        owner: context,
        userId: normalizedUserId,
        itemId: normalizedItemId
    });
    return promise;
}

JC.identity.registerReset('enhanced-item-cache', () => itemCache.clear());

/**
 * Debounce a function call
 * @param func - The function to debounce
 * @param wait - Wait time in ms
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function debounce<T extends (...args: any[]) => void>(func: T, wait: number): (...args: Parameters<T>) => void {
    let timeout: number | undefined;
    return function executedFunction(...args: Parameters<T>): void {
        const later = (): void => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = window.setTimeout(later, wait);
    };
}

/**
 * Throttle a function call
 * @param func - The function to throttle
 * @param limit - Time limit in ms
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function throttle<T extends (...args: any[]) => void>(func: T, limit: number): (this: unknown, ...args: Parameters<T>) => void {
    let inThrottle = false;
    return function (this: unknown, ...args: Parameters<T>): void {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => { inThrottle = false; }, limit);
        }
    };
}

/**
 * Retry a function with exponential backoff
 * @param fn - The async function to retry
 * @param maxAttempts - Maximum retry attempts (default: 5)
 * @param baseDelay - Base delay in ms (default: 1000)
 */
export async function retry<T>(fn: () => Promise<T> | T, maxAttempts = 5, baseDelay = 1000): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            if (attempt === maxAttempts) {
                console.error(`🪼 Jellyfin Canopy: Failed after ${maxAttempts} attempts:`, error);
                throw error;
            }

            const delay = baseDelay * Math.pow(2, attempt - 1);
            console.warn(`🪼 Jellyfin Canopy: Attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms...`, error);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw lastError;
}

/**
 * Check if an element is visible in the viewport
 * @param element - The element to check
 */
export function isElementVisible(element: Element | null | undefined): boolean {
    if (!element) return false;

    const rect = element.getBoundingClientRect();
    return (
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
        rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );
}

/**
 * Finds (or creates) the container plugin buttons should be injected into.
 *
 * Jellyfin 12's "experimental" layout (now the default) replaces the legacy
 * AngularJS header with a React/MUI AppBar+Toolbar. The legacy `.headerRight`
 * element is still present in the DOM for backwards compatibility, but it sits
 * inside a `display:none` wrapper, so injecting into it silently produces
 * invisible buttons. When that's detected, this reuses the toolbar's own
 * SyncPlay/RemotePlay/Search button tray (a `flexGrow:1; justifyContent:flex-end`
 * Box) as the container — it's the functional equivalent of `.headerRight`, and
 * injecting into it (rather than next to it) keeps plugin buttons right-aligned
 * with the native ones instead of stranding them as a separate flex item further
 * left in the toolbar.
 * @returns The container, or null if no header is ready yet.
 */
export function getHeaderRightContainer(): HTMLElement | null {
    // Serve the per-navigation cache while the node is still attached; failed
    // resolutions are NOT cached so early-boot retries still work.
    if (cachedHeaderRightContainer && cachedHeaderRightContainer.isConnected) {
        return cachedHeaderRightContainer;
    }
    cachedHeaderRightContainer = resolveHeaderRightContainer();
    return cachedHeaderRightContainer;
}

/** Uncached resolution behind {@link getHeaderRightContainer}. */
function resolveHeaderRightContainer(): HTMLElement | null {
    const legacy = document.querySelector<HTMLElement>('.headerRight');
    if (legacy && legacy.offsetParent !== null) return legacy;

    const userMenuButton = document.querySelector<HTMLElement>('[aria-controls="app-user-menu"]');
    const toolbar = userMenuButton?.closest('.MuiToolbar-root') || document.querySelector('.MuiAppBar-root .MuiToolbar-root');
    if (!toolbar) return null;

    // The legacy .headerButton/.paper-icon-button-light classes size themselves
    // with `em` units relative to the *inherited* font-size, which was tuned for
    // the old .skinHeader context. Inside the MUI toolbar the ambient font-size is
    // different, so the icons come out oversized/misaligned next to the native MUI
    // IconButtons. Pin them to MUI's own ~48px button / 24px icon convention instead.
    // !important is needed because some callers (e.g. active-streams.js) set their
    // own fixed-size CSS via an #id selector, which otherwise outranks this rule's
    // specificity regardless of declaration order.
    if (!muiHeaderButtonCSSInjected) {
        addCSS('jc-mui-header-button-fix', `
            .MuiToolbar-root .headerButton.paper-icon-button-light {
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                box-sizing: border-box !important;
                width: 48px !important;
                height: 48px !important;
                padding: 0 !important;
                margin: 0 !important;
                font-size: 16px !important;
            }
            .MuiToolbar-root .headerButton.paper-icon-button-light > .material-icons {
                font-size: 24px !important;
            }
        `);
        muiHeaderButtonCSSInjected = true;
    }

    let userMenuBox: HTMLElement | null = userMenuButton;
    while (userMenuBox && userMenuBox.parentElement !== toolbar) {
        userMenuBox = userMenuBox.parentElement;
    }
    const buttonsTray = userMenuBox?.previousElementSibling;
    if (buttonsTray) return buttonsTray as HTMLElement;

    // No user-menu available (e.g. public/video pages) - fall back to a
    // synthetic container appended to the toolbar itself.
    let container = toolbar.querySelector<HTMLElement>(':scope > .headerRight');
    if (!container) {
        container = document.createElement('div');
        container.className = 'headerRight';
        toolbar.appendChild(container);
    }
    return container;
}

/**
 * Finds the container plugin sidebar nav links should be injected into.
 *
 * The legacy `.mainDrawer-scrollContainer` is hidden the same way `.headerRight`
 * is under Jellyfin 12's experimental layout (both live inside the
 * `display:none`-wrapped legacy AppHeader). Unlike the header, there's no
 * always-present replacement: the new drawer (`AppDrawer`/`MainDrawerContent`,
 * a MUI `SwipeableDrawer`) is itself only ever rendered at all on narrow/mobile
 * viewports - desktop has no drawer in the new layout at all, nav lives inline
 * in the toolbar instead (see getHeaderRightContainer). So on desktop there is
 * no sidebar equivalent to fall back to; this returns null there, same as if
 * nothing existed yet, and callers' existing "wait and retry" logic covers it.
 */
export function getSidebarContainer(): HTMLElement | null {
    const legacy = document.querySelector<HTMLElement>('.mainDrawer-scrollContainer');
    if (legacy && legacy.offsetParent !== null) return legacy;

    // MUI's global stable class for the drawer's sliding panel. `keepMounted`
    // on the SwipeableDrawer means this exists in the DOM even while closed.
    const muiDrawerPanel = document.querySelector<HTMLElement>('.MuiDrawer-paper');
    if (!muiDrawerPanel) return null;

    return muiDrawerPanel.querySelector<HTMLElement>('[role="presentation"]') || muiDrawerPanel;
}

/**
 * Wait for a condition to be true
 * @param condition - Function that returns boolean
 * @param timeout - Maximum wait time in ms (default: 5000)
 * @param interval - Check interval in ms (default: 100)
 */
export function waitForCondition(condition: () => boolean, timeout = 5000, interval = 100): Promise<boolean> {
    return new Promise((resolve) => {
        const startTime = Date.now();

        const checkCondition = (): void => {
            if (condition()) {
                resolve(true);
                return;
            }

            if (Date.now() - startTime >= timeout) {
                console.warn('🪼 Jellyfin Canopy: Timeout waiting for condition');
                resolve(false);
                return;
            }

            setTimeout(checkCondition, interval);
        };

        checkCondition();
    });
}

/**
 * Add custom CSS to the page (alias of JC.core.ui.injectCss).
 * @param id - Unique ID for the style element
 * @param css - The CSS content
 */
export function addCSS(id: string, css: string): void {
    JC.core.ui!.injectCss(id, css);
}

export interface ExternalLinkOptions {
    /** Text content. */
    text?: string;
    /** Tooltip. */
    title?: string;
    /** CSS class(es). */
    className?: string;
    /** Strip emby-button chrome for plain-link appearance. */
    resetStyle?: boolean;
    /** Callback(el) for extra DOM work. */
    setup?: (el: HTMLAnchorElement) => void;
}

/**
 * Creates an external-link <a> that Jellyfin's native apps open in the system
 * browser (iOS SFSafariViewController, Android Custom Tabs) via `is="emby-linkbutton"`.
 *
 * Use this for every external URL in the plugin — one place, consistent behaviour.
 */
export function createExternalLink(url: string, options: ExternalLinkOptions = {}): HTMLAnchorElement {
    const a = document.createElement('a');
    // This attribute is what tells Jellyfin's native app shell to open the URL
    // in the system browser instead of the in-app WebView.
    a.setAttribute('is', 'emby-linkbutton');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    if (options.title)     a.title = options.title;
    if (options.className) a.className = options.className;
    if (options.text)      a.textContent = options.text;
    if (options.resetStyle) {
        // Strip the default emby-button chrome (padding, background, border-radius)
        // so the element renders as a plain unstyled link.
        a.style.cssText = 'padding:0;background:none;border-radius:0;min-width:0;';
    }
    if (typeof options.setup === 'function') options.setup(a);
    return a;
}

// Expose helpers. Entries marked (core) are thin aliases over JC.core.*
// kept for the frozen JC.helpers contract — new code should call core
// directly.
JC.helpers = {
    onViewPage: (callback: ViewPageCallback, options?: ViewPageOptions) => JC.core.navigation!.onViewPage(callback, options), // (core)
    onNavigate: (callback: NavigateCallback) => JC.core.navigation!.onNavigate(callback), // (core)
    getItemCached,
    getCurrentView: () => JC.core.navigation!.getCurrentView(), // (core)
    createObserver: (id: string, callback: MutationCallback, target: Node, config: MutationObserverInit) => JC.core.dom!.createObserver(id, callback, target, config), // (core)
    onBodyMutation: (id: string, callback: (mutations: MutationRecord[]) => void, options?: { priority?: number }) => JC.core.dom!.onBodyMutation(id, callback, options), // (core)
    removeBodySubscriber: (id: string) => JC.core.dom!.removeBodySubscriber(id), // (core)
    disconnectObserver: (id: string) => JC.core.dom!.disconnectObserver(id), // (core)
    disconnectAllObservers: () => JC.core.dom!.disconnectAllObservers(), // (core)
    getHeaderRightContainer,
    getSidebarContainer,
    waitForElement: (selector: string, timeout?: number) => JC.core.dom!.waitForElement(selector, timeout), // (core)
    waitForCondition,
    debounce,
    throttle,
    retry,
    isElementVisible,
    addCSS, // (core)
    removeCSS: (id: string) => JC.core.ui!.removeCss(id), // (core)
    escHtml: (s: unknown) => JC.core.ui!.escapeHtml(s), // (core)
    createExternalLink,
    getHandlerCount: () => JC.core.navigation!.getViewHandlerCount(), // (core)
    getObserverCount: () => JC.core.dom!.getObserverCount(), // (core)
    getBodySubscriberCount: () => JC.core.dom!.getBodySubscriberCount() // (core)
// JC.helpers is the frozen legacy alias surface (JELegacyHelpers, an index
// type); cast the whole literal so members like throttle/debounce assign
// against the index signature rather than being contextually re-typed.
} as typeof JC.helpers;

console.log('🪼 Jellyfin Canopy: Helpers initialized successfully');
